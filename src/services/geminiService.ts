import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { TranslationService, TranslationOptions } from "./translationService";

export class GeminiService implements TranslationService {
  private apiKeys: string[] = [];
  private modelName: string;
  private exhaustedKeys: Set<string> = new Set();
  private systemKey: string | null = null;
  private static globalKeyLastUsed: Map<string, number> = new Map();

  constructor(apiKeys?: string | string[], modelName: string = "gemini-flash-latest") {
    this.modelName = modelName;
    
    if (Array.isArray(apiKeys)) {
      this.apiKeys = apiKeys.filter(k => k && k.trim() !== "");
    } else if (apiKeys && apiKeys.trim() !== "") {
      this.apiKeys = apiKeys.split(/[,\n]/).map(k => k.trim()).filter(k => k !== "");
    }
    
    // Initialize lastUsed if not already in static map
    this.apiKeys.forEach(k => {
      if (!GeminiService.globalKeyLastUsed.has(k)) {
        GeminiService.globalKeyLastUsed.set(k, 0);
      }
    });
    
    const envKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (envKey && envKey.trim() !== "" && envKey !== "MY_GEMINI_API_KEY") {
      this.systemKey = envKey;
      if (!GeminiService.globalKeyLastUsed.has(envKey)) {
        GeminiService.globalKeyLastUsed.set(envKey, 0);
      }
    }

    console.log(`[MediTrans] GeminiService initialized with ${this.apiKeys.length} manual keys and ${this.systemKey ? '1' : '0'} system key. Model: ${modelName}`);
  }

  private getMIN_REQUEST_INTERVAL(): number {
    return 4000; // Standard Gemini Free Tier limit (15 RPM -> 1 req / 4s)
  }

  private getBestAvailableKey(): string | null {
    const availableKeys = [...this.apiKeys];
    if (this.systemKey) availableKeys.push(this.systemKey);

    // Filter out exhausted and sort by global last usage
    const sortedKeys = availableKeys
      .filter(k => !this.exhaustedKeys.has(k))
      .sort((a, b) => (GeminiService.globalKeyLastUsed.get(a) || 0) - (GeminiService.globalKeyLastUsed.get(b) || 0));

    return sortedKeys.length > 0 ? sortedKeys[0] : null;
  }

  private async acquireKeyAndInstance(): Promise<{ ai: any, key: string }> {
    const key = this.getBestAvailableKey();
    if (!key) throw new Error("Không có API Key nào khả dụng.");

    await this.waitForKeyRateLimit(key);
    
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      return { ai, key };
    } catch (e) {
      console.error("Failed to initialize GoogleGenAI with key:", key.substring(0, 8), e);
      throw e;
    }
  }

  private async waitForKeyRateLimit(key: string): Promise<void> {
    const now = Date.now();
    const lastUsed = GeminiService.globalKeyLastUsed.get(key) || 0;
    const interval = this.getMIN_REQUEST_INTERVAL();
    
    if (now - lastUsed < interval) {
      const waitTime = interval - (now - lastUsed);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    GeminiService.globalKeyLastUsed.set(key, Date.now());
  }

  private rotateKey(exhaustedKey: string, isQuotaError: boolean = true): boolean {
    if (exhaustedKey) {
      const duration = isQuotaError ? 60000 : 5000;
      this.exhaustedKeys.add(exhaustedKey);
      setTimeout(() => this.exhaustedKeys.delete(exhaustedKey), duration);
    }
    
    const availableKeys = [...this.apiKeys];
    if (this.systemKey) availableKeys.push(this.systemKey);
    return availableKeys.some(k => !this.exhaustedKeys.has(k));
  }

  async hasApiKey(): Promise<boolean> {
    return this.getBestAvailableKey() !== null;
  }

  async checkAvailableKeys(): Promise<{ envKey: boolean; manualKey: boolean; envKeyName?: string }> {
    const envKey = this.systemKey;
    const manualKey = this.apiKeys[0]; 
    
    const results = {
      envKey: !!envKey,
      manualKey: !!manualKey,
      envKeyName: envKey ? "Hệ thống (Environment)" : undefined
    };

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
      
      let ai, key;
      try {
        ({ ai, key } = await this.acquireKeyAndInstance());
      } catch (e: any) {
        throw new Error("Không tìm thấy API Key khả dụng. Vui lòng kiểm tra lại Key trong Cài đặt.");
      }

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
            chunkText = chunkText.replace(/\.{6,}/g, '.....');
            fullText += chunkText;
            yield chunkText;
          }
        }

        if (!fullText) {
          throw new Error("Model returned no text.");
        }
        
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
          const canRotate = this.rotateKey(key, isQuotaError);
          if (canRotate) {
            const errorType = isQuotaError ? "Quota limited" : "High demand";
            console.log(`[MediTrans] ${errorType}. Rotated to a different API Key. Retrying...`);
            retryCount++;
            const baseDelay = isQuotaError ? 1000 : 500;
            await new Promise(resolve => setTimeout(resolve, baseDelay + Math.random() * 500));
            continue;
          }

          retryCount++;
          const delay = Math.pow(2, retryCount) * 1000 + Math.random() * 1000;
          console.warn(`All keys exhausted. Retrying in ${Math.round(delay)}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }
  }

  async translateMedicalPage(options: TranslationOptions): Promise<string> {
    const { imageBuffer, pageNumber, signal } = options;
    
    if (signal?.aborted) {
      throw new Error("Translation aborted");
    }

    const MAX_RETRIES = 5;
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      if (signal?.aborted) {
        throw new Error("Translation aborted");
      }
      
      let ai, key;
      try {
        ({ ai, key } = await this.acquireKeyAndInstance());
      } catch (e) {
        throw new Error("Không tìm thấy API Key khả dụng.");
      }

      const systemInstruction = `Dịch Y khoa OCR: Trích xuất & dịch TOÀN BỘ văn bản từ ảnh sang tiếng Việt.
Sử dụng Markdown, giữ nguyên cấu trúc (bảng, danh sách).
Thuật ngữ y khoa chuẩn. Không thêm lời dẫn.
Rút gọn chuỗi dấu chấm (.) thành 3-5 dấu.
Mỗi mục lục một dòng. Số trang khớp ảnh.`;

      const prompt = `Dịch trang ${pageNumber} sang tiếng Việt.`;

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
        text = text.replace(/\.{6,}/g, '.....');
        return text;
      } catch (error: any) {
        if (signal?.aborted || error.message === "Translation aborted") {
          throw new Error("Translation aborted");
        }
        const isQuotaError = error.message?.toLowerCase().includes("quota") || 
                           error.message?.toLowerCase().includes("429") ||
                           error.message?.toLowerCase().includes("resource_exhausted");
        
        if (isQuotaError && retryCount < MAX_RETRIES) {
          const canRotate = this.rotateKey(key);
          if (canRotate) {
            retryCount++;
            continue;
          }
        }
        throw error;
      }
    }
    return "Lỗi: Quá số lần thử lại.";
  }

  async lookupMedicalTerm(term: string): Promise<any> {
    const systemInstruction = `Chuyên gia từ điển y khoa: Cung cấp định nghĩa, dịch nghĩa, đồng nghĩa cho thuật ngữ y khoa bằng tiếng Việt. Chính xác, chuyên sâu, không bịa đặt.`;

    const prompt = `Hãy tra cứu thuật ngữ y khoa sau: "${term}"`;

    const MAX_RETRIES = 2;
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      let ai, key;
      try {
        ({ ai, key } = await this.acquireKeyAndInstance());
      } catch (e) {
        throw new Error("Không tìm thấy API Key.");
      }

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
        
        const cleanJson = text.replace(/```json\n?|```/g, '').trim();
        return JSON.parse(cleanJson);
      } catch (error: any) {
        const isQuotaError = error.message?.toLowerCase().includes("quota") || 
                           error.message?.toLowerCase().includes("429") ||
                           error.message?.toLowerCase().includes("resource_exhausted");
        
        if (isQuotaError && retryCount < MAX_RETRIES) {
          const canRotate = this.rotateKey(key, true);
          if (canRotate) {
            retryCount++;
            continue;
          }
        }
        throw error;
      }
    }
  }

  async performOCR(imageBuffer: string): Promise<string> {
    let ai, key;
    try {
      ({ ai, key } = await this.acquireKeyAndInstance());
    } catch (e) {
      throw new Error("Không có API Key khả dụng.");
    }

    const systemInstruction = `
      Bạn là một chuyên gia OCR (Nhận diện ký tự quang học) y khoa.
      Nhiệm vụ của bạn là trích xuất CHÍNH XÁC văn bản từ hình ảnh vùng được chọn.
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

    const MAX_RETRIES = 5;
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      if (signal?.aborted) throw new Error("Summarization aborted");

      let ai, key;
      try {
        ({ ai, key } = await this.acquireKeyAndInstance());
      } catch (e) {
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
          const rotated = this.rotateKey(key, true);
          if (rotated) {
            retryCount++;
            continue;
          }
        }

        throw error;
      }
    }
  }
}
