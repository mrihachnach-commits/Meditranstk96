import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { TranslationService, TranslationOptions } from "./translationService";

export class GeminiService implements TranslationService {
  private apiKeys: string[] = [];
  private modelName: string;
  private aiInstance: any = null;
  private lastKey: string | null = null;
  private exhaustedKeys: Set<string> = new Set();
  private lastUsed: Map<string, number> = new Map();
  private systemKey: string | null = null;
  private static lastRequestTime: number = 0;

  constructor(apiKeys?: string | string[], modelName: string = "gemini-flash-latest") {
    this.modelName = modelName;
    
    if (Array.isArray(apiKeys)) {
      this.apiKeys = apiKeys.filter(k => k && k.trim() !== "");
    } else if (apiKeys && apiKeys.trim() !== "") {
      this.apiKeys = apiKeys.split(/[,\n]/).map(k => k.trim()).filter(k => k !== "");
    }
    
    // Initialize lastUsed for all keys
    this.apiKeys.forEach(k => this.lastUsed.set(k, 0));
    
    const envKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (envKey && envKey.trim() !== "" && envKey !== "MY_GEMINI_API_KEY") {
      this.systemKey = envKey;
      this.lastUsed.set(envKey, 0);
    }

    console.log(`[MediTrans] GeminiService initialized with ${this.apiKeys.length} manual keys and ${this.systemKey ? '1' : '0'} system key. Model: ${modelName}`);
  }

  private getMIN_REQUEST_INTERVAL(): number {
    const totalKeys = this.apiKeys.length + (this.systemKey ? 1 : 0);
    // Each key has a ~15 RPM limit on Gemini Flash (1 request per 4s)
    // To be safe and distribute load, we can lower the interval as we add keys
    if (totalKeys > 4) return 500; // max 120 RPM
    if (totalKeys > 1) return 800; // max 75 RPM
    return 1500; // Default fallback for single key (40 RPM, still higher than 15 but handles bursts)
  }

  private getAIInstance(): any {
    let key = "";
    
    // Build list of all potential available keys
    const availableKeys = [...this.apiKeys];
    if (this.systemKey) availableKeys.push(this.systemKey);

    // Filter out exhausted and sort by last usage (Oldest usage first = Optimal rotation)
    const sortedKeys = availableKeys
      .filter(k => !this.exhaustedKeys.has(k))
      .sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0));

    if (sortedKeys.length > 0) {
      key = sortedKeys[0];
      this.lastUsed.set(key, Date.now());
    }
    
    if (!key || key.trim() === "") {
      return null;
    }
    
    if (this.aiInstance && this.lastKey === key) {
      return this.aiInstance;
    }

    try {
      this.aiInstance = new GoogleGenAI({ apiKey: key });
      this.lastKey = key;
      return this.aiInstance;
    } catch (e) {
      console.error("Failed to initialize GoogleGenAI:", e);
      return null;
    }
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - GeminiService.lastRequestTime;
    const interval = this.getMIN_REQUEST_INTERVAL();
    if (timeSinceLastRequest < interval) {
      const waitTime = interval - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    GeminiService.lastRequestTime = Date.now();
  }

  private rotateKey(isQuotaError: boolean = true): boolean {
    const currentKey = this.lastKey;
    if (currentKey) {
      // 429 Quota errors usually last 1 minute on Gemini Free Tier
      // 503/Overloaded errors are transient (5s)
      const duration = isQuotaError ? 60000 : 5000;
      const typeStr = isQuotaError ? "Quota Limit (429)" : "High Demand (503)";
      
      console.warn(`[MediTrans] Key exhausted: ${currentKey.substring(0, 8)}... (${typeStr}). Marking as exhausted for ${duration / 1000}s.`);
      
      this.exhaustedKeys.add(currentKey);
      setTimeout(() => {
        this.exhaustedKeys.delete(currentKey);
      }, duration);
    }

    this.aiInstance = null;
    this.lastKey = null;
    
    // Check if we have ANY key left to try
    const availableKeys = [...this.apiKeys];
    if (this.systemKey) availableKeys.push(this.systemKey);
    const hasAny = availableKeys.some(k => !this.exhaustedKeys.has(k));
    
    return hasAny;
  }

  async hasApiKey(): Promise<boolean> {
    return this.getAIInstance() !== null;
  }

  async checkAvailableKeys(): Promise<{ envKey: boolean; manualKey: boolean; envKeyName?: string }> {
    const envKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    const manualKey = this.apiKeys[0]; // Check the first manual key if available
    
    const results = {
      envKey: false,
      manualKey: false,
      envKeyName: envKey ? "Hệ thống (Environment)" : undefined
    };

    // Only check for presence and basic format, no network call to save quota
    if (envKey && envKey.trim() !== "" && envKey !== "MY_GEMINI_API_KEY") {
      results.envKey = true;
    }

    if (manualKey && manualKey.trim() !== "") {
      results.manualKey = true;
    }

    return results;
  }

  async openKeySelection(): Promise<void> {
    if (typeof window !== 'undefined' && (window as any).aistudio?.openSelectKey) {
      await (window as any).aistudio.openSelectKey();
    }
  }

  async *translateMedicalPageStream(options: TranslationOptions): AsyncGenerator<string> {
    const { imageBuffer, pageNumber, signal } = options;
    
    if (signal?.aborted) {
      throw new Error("Translation aborted");
    }

    const systemInstruction = `Dịch Y khoa OCR: Trích xuất & dịch TOÀN BỘ văn bản từ ảnh sang tiếng Việt.
Sử dụng Markdown, giữ nguyên cấu trúc (bảng, danh sách).
Thuật ngữ y khoa chuẩn. Không thêm lời dẫn.
Rút gọn chuỗi dấu chấm (.) thành 3-5 dấu.
Mỗi mục lục một dòng. Số trang khớp ảnh.`;

    const prompt = `Dịch trang ${pageNumber} sang tiếng Việt.`;

    const MAX_RETRIES = 5;
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      if (signal?.aborted) {
        throw new Error("Translation aborted");
      }
      
      const ai = this.getAIInstance();
      if (!ai) {
        throw new Error("Không tìm thấy API Key khả dụng. Vui lòng kiểm tra lại Key trong Cài đặt.");
      }

      await this.waitForRateLimit();

      try {
        const response = await ai.models.generateContentStream({
          model: this.modelName,
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: imageBuffer.split(",")[1],
                  },
                },
              ],
            },
          ],
          config: {
            systemInstruction: systemInstruction,
            temperature: 0
          }
        });

        let fullText = "";
        for await (const chunk of response) {
          if (signal?.aborted) {
            throw new Error("Translation aborted");
          }
          let chunkText = chunk.text;
          if (chunkText) {
            // Hậu xử lý để tránh lỗi lặp dấu chấm quá nhiều gây treo UI hoặc lỗi model
            // Thay thế chuỗi 6 dấu chấm trở lên bằng đúng 5 dấu chấm
            chunkText = chunkText.replace(/\.{6,}/g, '.....');
            
            fullText += chunkText;
            yield chunkText;
          }
        }

        if (!fullText) {
          throw new Error("Model returned no text.");
        }
        
        // Success, break the retry loop
        break;

      } catch (error: any) {
        if (signal?.aborted || error.message === "Translation aborted") {
          throw new Error("Translation aborted");
        }
        const isQuotaError = error.message?.toLowerCase().includes("quota") || 
                           error.message?.toLowerCase().includes("429") ||
                           error.message?.toLowerCase().includes("resource_exhausted");
        const isUnavailableError = error.message?.toLowerCase().includes("unavailable") || 
                                 error.message?.toLowerCase().includes("503") ||
                                 error.message?.toLowerCase().includes("high demand");
        
        if ((isQuotaError || isUnavailableError) && retryCount < MAX_RETRIES) {
          const canRotate = this.rotateKey(isQuotaError);
          if (canRotate) {
            const errorType = isQuotaError ? "Quota limited" : "High demand";
            console.log(`[MediTrans] ${errorType}. Rotated to a different API Key. Retrying...`);
            retryCount++;
            const baseDelay = isQuotaError ? 2000 : 1000;
            await new Promise(resolve => setTimeout(resolve, baseDelay + Math.random() * 1000));
            continue;
          }

          retryCount++;
          const delay = Math.pow(2, retryCount) * 2000 + Math.random() * 2000;
          const errorType = isQuotaError ? "Quota exceeded (All keys)" : "Model unavailable (503)";
          console.warn(`${errorType}. Retrying in ${Math.round(delay)}ms... (Attempt ${retryCount}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        console.error("Gemini Pro Streaming Error:", error);
        
        if (error.message?.includes("API key not valid")) {
          throw new Error("API Key không hợp lệ. Vui lòng kiểm tra lại trong phần Cài đặt.");
        }
        if (isQuotaError) {
          const totalKeys = this.apiKeys.length + (this.systemKey ? 1 : 0);
          throw new Error(`Bạn đã hết hạn mức sử dụng API (Quota exceeded). 
            Hệ thống đã thử qua tất cả ${totalKeys} API Key khả dụng nhưng đều đã chạm giới hạn (15 yêu cầu/phút mỗi Key).
            Vui lòng đợi khoảng 1 phút hoặc thêm API Key mới trong phần Cài đặt.`);
        }
        if (isUnavailableError) {
          throw new Error("Hệ thống đang quá tải do nhu cầu sử dụng cao. Vui lòng thử lại sau giây lát.");
        }
        throw new Error(`Lỗi dịch thuật: ${error.message || "Không rõ nguyên nhân"}`);
      }
    }
  }

  async translateMedicalPage(options: TranslationOptions): Promise<string> {
    const { imageBuffer, pageNumber, signal } = options;
    
    if (signal?.aborted) {
      throw new Error("Translation aborted");
    }

    const ai = this.getAIInstance();
    if (!ai) {
      throw new Error("Không tìm thấy API Key. Vui lòng nhập API Key trong phần Cài đặt hoặc chọn API Key từ hệ thống.");
    }

    const systemInstruction = `Dịch Y khoa OCR: Trích xuất & dịch TOÀN BỘ văn bản từ ảnh sang tiếng Việt.
Sử dụng Markdown, giữ nguyên cấu trúc (bảng, danh sách).
Thuật ngữ y khoa chuẩn. Không thêm lời dẫn.
Rút gọn chuỗi dấu chấm (.) thành 3-5 dấu.
Mỗi mục lục một dòng. Số trang khớp ảnh.`;

    const prompt = `Dịch trang ${pageNumber} sang tiếng Việt.`;

    const MAX_RETRIES = 5;
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      if (signal?.aborted) {
        throw new Error("Translation aborted");
      }
      
      await this.waitForRateLimit();

      try {
        const response = await ai.models.generateContent({
          model: this.modelName,
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: imageBuffer.split(",")[1],
                  },
                },
              ],
            },
          ],
          config: {
            systemInstruction: systemInstruction,
            temperature: 0
          }
        });

        let text = response.text || "Model returned no text.";
        // Hậu xử lý để tránh lỗi lặp dấu chấm quá nhiều
        text = text.replace(/\.{6,}/g, '.....');
        return text;
      } catch (error: any) {
        if (signal?.aborted || error.message === "Translation aborted") {
          throw new Error("Translation aborted");
        }
        const isQuotaError = error.message?.toLowerCase().includes("quota") || 
                           error.message?.toLowerCase().includes("429") ||
                           error.message?.toLowerCase().includes("resource_exhausted");
        const isUnavailableError = error.message?.toLowerCase().includes("unavailable") || 
                                 error.message?.toLowerCase().includes("503") ||
                                 error.message?.toLowerCase().includes("high demand");
        
        if ((isQuotaError || isUnavailableError) && retryCount < MAX_RETRIES) {
          if (isQuotaError) {
            const canRotate = this.rotateKey();
            if (canRotate) {
              console.log(`[MediTrans] Quota exceeded. Rotated to a different API Key. Retrying...`);
              retryCount++;
              await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
              continue;
            }
          }

          retryCount++;
          const delay = Math.pow(2, retryCount) * 2000 + Math.random() * 2000;
          const errorType = isQuotaError ? "Quota exceeded (All keys)" : "Model unavailable (503)";
          console.warn(`${errorType}. Retrying in ${Math.round(delay)}ms... (Attempt ${retryCount}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        console.error("Gemini Translation Error:", error);
        
        if (error.message?.includes("API key not valid")) {
          throw new Error("API Key không hợp lệ. Vui lòng kiểm tra lại trong phần Cài đặt.");
        }
        if (isQuotaError) {
          const totalKeys = this.apiKeys.length + (this.systemKey ? 1 : 0);
          throw new Error(`Bạn đã hết hạn mức sử dụng API (Quota exceeded). 
            Hệ thống đã tự động thử qua ${totalKeys} API Key khả dụng nhưng tất cả đều đã chạm giới hạn (15 yêu cầu/phút mỗi Key).
            Vui lòng đợi khoảng 1 phút để các Key hồi phục hoặc thêm API Key mới trong phần Cài đặt.`);
        }
        if (isUnavailableError) {
          throw new Error("Hệ thống đang quá tải do nhu cầu sử dụng cao. Vui lòng thử lại sau giây lát.");
        }
        throw new Error(`Lỗi dịch thuật: ${error.message || "Không rõ nguyên nhân"}`);
      }
    }
    return "Lỗi: Quá số lần thử lại.";
  }

  async lookupMedicalTerm(term: string): Promise<any> {
    const ai = this.getAIInstance();

    if (!ai) {
      throw new Error("Không tìm thấy API Key. Vui lòng nhập API Key trong phần Cài đặt hoặc chọn API Key từ hệ thống.");
    }

    const systemInstruction = `Chuyên gia từ điển y khoa: Cung cấp định nghĩa, dịch nghĩa, đồng nghĩa cho thuật ngữ y khoa bằng tiếng Việt. Chính xác, chuyên sâu, không bịa đặt.`;

    const prompt = `Hãy tra cứu thuật ngữ y khoa sau: "${term}"`;

    const MAX_RETRIES = 2;
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      try {
        const response = await ai.models.generateContent({
          model: this.modelName,
          contents: [{ parts: [{ text: prompt }] }],
          config: {
            systemInstruction: systemInstruction,
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                term: { type: Type.STRING, description: "BẮT BUỘC: Phải giống hệt với từ/cụm từ được tra cứu ở prompt" },
                definition: { type: Type.STRING, description: "Định nghĩa chi tiết hoặc dịch nghĩa bằng tiếng Việt" },
                synonyms: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING },
                  description: "Danh sách các từ đồng nghĩa hoặc tên gọi khác"
                },
                relatedTerms: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING },
                  description: "Các thuật ngữ y khoa liên quan mật thiết"
                },
                source: { type: Type.STRING, description: "Nguồn tham khảo uy tín" }
              },
              required: ["term", "definition", "synonyms", "relatedTerms"]
            }
          }
        });

        const text = response.text;
        if (!text) throw new Error("Model returned no text.");
        
        // Clean up potential markdown code blocks
        const cleanJson = text.replace(/```json\n?|```/g, '').trim();
        return JSON.parse(cleanJson);
      } catch (error: any) {
        const isQuotaError = error.message?.toLowerCase().includes("quota") || 
                           error.message?.toLowerCase().includes("429") ||
                           error.message?.toLowerCase().includes("resource_exhausted");
        const isUnavailableError = error.message?.toLowerCase().includes("unavailable") || 
                                 error.message?.toLowerCase().includes("503") ||
                                 error.message?.toLowerCase().includes("high demand");
        
        if ((isQuotaError || isUnavailableError) && retryCount < MAX_RETRIES) {
          if (isQuotaError) {
            const canRotate = this.rotateKey();
            if (canRotate) {
              retryCount++;
              await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
              continue;
            }
          }

          retryCount++;
          const delay = Math.pow(2, retryCount) * 1000 + Math.random() * 1000;
          const errorType = isQuotaError ? "Quota exceeded" : "Model unavailable (503)";
          console.warn(`${errorType} for lookup. Retrying in ${Math.round(delay)}ms... (Attempt ${retryCount}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        if (isQuotaError) {
          const totalKeys = this.apiKeys.length + (this.systemKey ? 1 : 0);
          throw new Error(`Bạn đã hết hạn mức sử dụng API (Quota exceeded). 
            Hệ thống đã tự động thử qua ${totalKeys} API Key khả dụng nhưng tất cả đều đã chạm giới hạn (15 yêu cầu/phút mỗi Key).
            Vui lòng đợi khoảng 1 phút để các Key hồi phục hoặc thêm API Key mới trong phần Cài đặt.`);
        }
        if (isUnavailableError) {
          throw new Error("Hệ thống đang quá tải do nhu cầu sử dụng cao. Vui lòng thử lại sau giây lát.");
        }
        throw new Error(`Lỗi tra cứu: ${error.message || "Không rõ nguyên nhân"}`);
      }
    }
  }

  async performOCR(imageBuffer: string): Promise<string> {
    const ai = this.getAIInstance();

    if (!ai) {
      throw new Error("Không tìm thấy API Key. Vui lòng nhập API Key trong phần Cài đặt hoặc chọn API Key từ hệ thống.");
    }

    const systemInstruction = `
      Bạn là một chuyên gia OCR (Nhận diện ký tự quang học) y khoa.
      Nhiệm vụ của bạn là trích xuất CHÍNH XÁC văn bản từ hình ảnh vùng được chọn.
      
      YÊU CẦU:
      1. Chỉ trả về văn bản được trích xuất, không thêm lời dẫn, không giải thích.
      2. Nếu vùng chọn chứa thuật ngữ y khoa, hãy trích xuất chính xác thuật ngữ đó.
      3. Nếu vùng chọn chứa nhiều dòng, hãy nối chúng lại thành một chuỗi văn bản hợp lý.
      4. Nếu không tìm thấy văn bản nào, hãy trả về chuỗi rỗng.
    `;

    const prompt = "Hãy trích xuất văn bản từ hình ảnh này.";

    try {
      const response = await ai.models.generateContent({
        model: this.modelName,
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: imageBuffer.split(",")[1],
                },
              },
            ],
          },
        ],
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.1,
          thinkingConfig: { 
            thinkingLevel: this.modelName.includes("pro") ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL 
          },
        }
      });

      return response.text?.trim() || "";
    } catch (error: any) {
      console.error("Gemini OCR Error:", error);
      throw new Error(`Lỗi OCR: ${error.message || "Không rõ nguyên nhân"}`);
    }
  }

  async *summarizeContent(content: string, type: 'page' | 'document' | 'chapter', signal?: AbortSignal): AsyncGenerator<string> {
    const typeLabels = {
      page: "trang hiện tại",
      document: "toàn bộ tài liệu",
      chapter: "chương/phần này"
    };

    const systemInstruction = `Bạn là một bác sĩ chuyên khoa cấp cao và nhà nghiên cứu y học uy tín.
Nghiêm túc phân tích và tóm tắt chi tiết nội dung y khoa để hỗ trợ cập nhật kiến thức chuyên môn cho nhân viên y tế.

Yêu cầu bản tóm tắt phải CHUYÊN SÂU và bao quát:
1. Tổng quan & Bối cảnh: Mục đích chính của văn bản.
2. Cơ chế bệnh sinh & Nguyên lý y học.
3. Chẩn đoán & Cận lâm sàng: Các triệu chứng và xét nghiệm quan trọng.
4. Điều trị & Quản lý: Can thiệp, dược lý học, quy trình thực hành.
5. Cập nhật & Điểm mới: Các bằng chứng y học mới nhất.
6. Kết luận & Ứng dụng thực hành.

Phong cách: Markdown chuyên nghiệp (H2, H3, bảng), in đậm thuật ngữ chuyên môn.`;

    const prompt = `Hãy tóm tắt nội dung sau đây (${typeLabels[type]}):\n\n${content}`;

    const MAX_RETRIES = 5;
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      if (signal?.aborted) throw new Error("Summarization aborted");

      const ai = this.getAIInstance();
      if (!ai) {
        throw new Error("Không tìm thấy API Key.");
      }

      const systemInstruction = `Bạn là một bác sĩ chuyên khoa cấp cao và nhà nghiên cứu y học uy tín.
Nhiệm vụ: Phân tích và tóm tắt chi tiết nội dung y khoa để hỗ trợ cập nhật kiến thức chuyên môn cho nhân viên y tế.

Yêu cầu bản tóm tắt phải CHI TIẾT, ĐẦY ĐỦ, CHUYÊN SÂU và bao quát các phương diện sau:
1. Tổng quan & Bối cảnh: Tóm tắt mục đích chính của văn bản, tầm quan trọng của vấn đề y khoa được đề cập.
2. Cơ chế bệnh sinh & Nguyên lý y học: Giải thích chi tiết các quá trình sinh lý bệnh hoặc nguyên lý khoa học cốt lõi.
3. Chẩn đoán & Cận lâm sàng: Liệt kê chi tiết các triệu chứng then chốt, tiêu chuẩn chẩn đoán, phân độ lâm sàng và các xét nghiệm/cận lâm sàng quan trọng nhất.
4. Phác đồ Điều trị & Quản lý: Chi tiết các biện pháp can thiệp, dược lý học (tên thuốc, cơ chế), quy trình thực hành và lưu ý đặc biệt.
5. Những cập nhật & Điểm mới quan trọng: Nhấn mạnh các kiến thức mới, thay đổi trong Evidence-Based Medicine (Y học dựa trên bằng chứng) hoặc các thay đổi trong Guideline quốc tế.
6. Kết luận & Ứng dụng thực hành: Các thông điệp then chốt cần ghi nhớ và cách áp dụng trực tiếp vào thực hành lâm sàng.

Phong cách trình bày:
- Sử dụng Markdown chuyên nghiệp (Tiêu đề H2, H3, Danh sách có thứ tự).
- In đậm (**bold**) các thuật ngữ y khoa, tên thuốc, chỉ số labo và các kiến thức quan trọng.
- Ngôn ngữ: Tiếng Việt y khoa chuyên sâu, trang trọng, chính xác tuyệt đối.
- Nếu có dữ liệu so sánh, hãy trình bày dưới dạng bảng (Markdown Tables).`;

      const prompt = `Hãy tóm tắt nội dung sau đây (${typeLabels[type]}):

${content}`;

      await this.waitForRateLimit();

      try {
        const response = await ai.models.generateContentStream({
          model: this.modelName,
          contents: [{ parts: [{ text: prompt }] }],
          config: {
            systemInstruction: systemInstruction,
            temperature: 0.2
          }
        });

        let hasData = false;
        for await (const chunk of response) {
          if (signal?.aborted) throw new Error("Summarization aborted");
          const chunkText = chunk.text;
          if (chunkText) {
            hasData = true;
            yield chunkText;
          }
        }

        if (hasData) break;
        else throw new Error("No data returned from summary stream");

      } catch (error: any) {
        if (signal?.aborted) throw new Error("Summarization aborted");
        
        const isQuotaError = error.message?.toLowerCase().includes("quota") || 
                            error.message?.toLowerCase().includes("429") ||
                            error.message?.toLowerCase().includes("resource_exhausted");
        
        if (isQuotaError && retryCount < MAX_RETRIES) {
          const rotated = this.rotateKey(true);
          if (rotated) {
            console.log(`[MediTrans] Summary Quota exceeded. Rotated Key. Retrying...`);
            retryCount++;
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
            continue;
          }
        }

        console.error("Gemini Summarization Error:", error);
        throw new Error(`Lỗi tóm tắt: ${error.message || "Không rõ nguyên nhân"}`);
      }
    }
  }
}
