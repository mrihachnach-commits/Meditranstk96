import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { TranslationService, TranslationOptions } from "./translationService";

export class GeminiService implements TranslationService {
  private apiKeys: string[] = [];
  private currentKeyIndex: number = 0;
  private modelName: string;
  private aiInstance: any = null;
  private lastKey: string | null = null;
  private exhaustedKeys: Set<string> = new Set();
  private systemKey: string | null = null;
  private static lastRequestTime: number = 0;
  private static MIN_REQUEST_INTERVAL: number = 1500; // Minimum 1.5s between any two requests to stay safe

  constructor(apiKeys?: string | string[], modelName: string = "gemini-flash-latest") {
    this.modelName = modelName;
    
    if (Array.isArray(apiKeys)) {
      this.apiKeys = apiKeys.filter(k => k && k.trim() !== "");
    } else if (apiKeys && apiKeys.trim() !== "") {
      // Support comma or newline separated keys
      this.apiKeys = apiKeys.split(/[,\n]/).map(k => k.trim()).filter(k => k !== "");
    }
    
    // Get system key from environment
    const envKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (envKey && envKey.trim() !== "" && envKey !== "MY_GEMINI_API_KEY") {
      this.systemKey = envKey;
    }

    console.log(`[MediTrans] GeminiService initialized with ${this.apiKeys.length} manual keys and ${this.systemKey ? '1' : '0'} system key. Model: ${modelName}`);
  }

  private getAIInstance(): any {
    let key = "";
    
    // 1. Try to find a non-exhausted manual key
    if (this.apiKeys.length > 0) {
      // Start from currentKeyIndex and look for a non-exhausted key
      for (let i = 0; i < this.apiKeys.length; i++) {
        const idx = (this.currentKeyIndex + i) % this.apiKeys.length;
        const potentialKey = this.apiKeys[idx];
        if (!this.exhaustedKeys.has(potentialKey)) {
          key = potentialKey;
          this.currentKeyIndex = idx;
          break;
        }
      }
    }
    
    // 2. Fallback to system key if no manual key found or all manual keys exhausted
    if (!key && this.systemKey && !this.exhaustedKeys.has(this.systemKey)) {
      key = this.systemKey;
    }
    
    // If still no key, we can't proceed
    if (!key || key.trim() === "") {
      return null;
    }
    
    // Cache the instance if the key hasn't changed
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
    if (timeSinceLastRequest < GeminiService.MIN_REQUEST_INTERVAL) {
      const waitTime = GeminiService.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    GeminiService.lastRequestTime = Date.now();
  }

  private rotateKey(): boolean {
    const currentKey = this.lastKey;
    if (currentKey) {
      console.warn(`[MediTrans] Key exhausted: ${currentKey.substring(0, 8)}... Marking as exhausted for 60s.`);
      this.exhaustedKeys.add(currentKey);
      // Reset exhausted status after 60 seconds
      setTimeout(() => {
        this.exhaustedKeys.delete(currentKey);
        console.log(`[MediTrans] Key recovered: ${currentKey.substring(0, 8)}...`);
      }, 60000);
    }

    // Force re-selection in next getAIInstance call
    this.aiInstance = null;
    this.lastKey = null;
    
    // Move to next index for next attempt
    if (this.apiKeys.length > 0) {
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    }

    // Check if we have ANY key left to try
    const hasManualKey = this.apiKeys.some(k => !this.exhaustedKeys.has(k));
    const hasSystemKey = this.systemKey && !this.exhaustedKeys.has(this.systemKey);
    
    return !!(hasManualKey || hasSystemKey);
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

    const MAX_RETRIES = 5; // Increased retries
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      if (signal?.aborted) {
        throw new Error("Translation aborted");
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
          // If it's a quota error, try to rotate the key first
          if (isQuotaError) {
            const canRotate = this.rotateKey();
            if (canRotate) {
              console.log(`[MediTrans] Quota exceeded. Rotated to a different API Key. Retrying...`);
              retryCount++;
              // Jittered delay when rotating
              await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
              continue;
            }
          }

          retryCount++;
          // Exponential backoff with jitter
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
            Hệ thống đã tự động thử qua ${totalKeys} API Key khả dụng nhưng tất cả đều đã chạm giới hạn (15 yêu cầu/phút mỗi Key).
            Vui lòng đợi khoảng 1 phút để các Key hồi phục hoặc thêm API Key mới trong phần Cài đặt.`);
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
}
