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
    return 1000;
  }

  private getBestAvailableKey(): string | null {
    const availableKeys = [...this.apiKeys];
    if (this.systemKey) availableKeys.push(this.systemKey);

    if (availableKeys.length === 0) return null;

    const validKeys = availableKeys.filter(k => !this.exhaustedKeys.has(k));
    if (validKeys.length === 0) return null;

    validKeys.sort((a, b) => (GeminiService.globalKeyLastUsed.get(a) || 0) - (GeminiService.globalKeyLastUsed.get(b) || 0));

    return validKeys[0];
  }

  private async acquireKeyAndInstance(): Promise<{ ai: any, key: string }> {
    const key = this.getBestAvailableKey();
    if (!key) throw new Error("Không có API Key khả dụng (Tất cả đang bảo trì hoặc hết hạn mức).");

    await this.waitForKeyRateLimit(key);
    
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      return { ai, key };
    } catch (e) {
      console.error("[MediTrans] Failed to initialize GoogleGenAI with key:", key.substring(0, 8), e);
      throw e;
    }
  }

  private async waitForKeyRateLimit(key: string): Promise<void> {
    const now = Date.now();
    const lastUsed = GeminiService.globalKeyLastUsed.get(key) || 0;
    const interval = this.getMIN_REQUEST_INTERVAL();
    
    if (now - lastUsed < interval) {
      const waitTime = interval - (now - lastUsed);
      if (waitTime > 50) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    GeminiService.globalKeyLastUsed.set(key, Date.now());
  }

  private rotateKey(exhaustedKey: string, isQuotaError: boolean = true): boolean {
    if (exhaustedKey) {
      const duration = isQuotaError ? 60000 : 2000;
      this.exhaustedKeys.add(exhaustedKey);
      setTimeout(() => this.exhaustedKeys.delete(exhaustedKey), duration);
    }
    
    return this.getBestAvailableKey() !== null;
  }

  async hasApiKey(): Promise<boolean> {
    return this.getBestAvailableKey() !== null;
  }

  async checkAvailableKeys(): Promise<{ envKey: boolean; manualKey: boolean; envKeyName?: string }> {
    const envKey = this.systemKey;
    const manualKey = this.apiKeys[0]; 
    
    return {
      envKey: !!envKey,
      manualKey: !!manualKey,
      envKeyName: envKey ? "Hệ thống (Environment)" : undefined
    };
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

    const systemInstruction = `BẠN LÀ MỘT CHUYÊN GIA DỊCH THUẬT Y KHOA OCR.
NHIỆM VỤ: Trích xuất và dịch TOÀN BỘ văn bản từ TRANG SỐ ${pageNumber} trong hình ảnh sang tiếng Việt.

YÊU CẦU QUAN TRỌNG:
1. CHỈ DỊCH nội dung của trang này, không thêm nội dung từ các trang trước hoặc sau.
2. Sử dụng Markdown, giữ nguyên cấu trúc (bảng, danh sách, tiêu đề).
3. Sử dụng thuật ngữ y khoa chuyên môn chuẩn tiếng Việt. 
4. KHÔNG THÊM lời dẫn hoặc kết luận.
5. Rút gọn chuỗi dấu chấm (.) dài thành tối đa 3-5 dấu.`;

    const prompt = `Hãy dịch văn bản trong hình ảnh (Trang ${pageNumber}) sang tiếng Việt.`;

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
        const isPermissionDeniedError = error.message?.toLowerCase().includes("permission_denied") || 
                                       error.message?.toLowerCase().includes("403") ||
                                       error.message?.toLowerCase().includes("denied access");
        const isNetworkError = error.message?.includes("status code: 0") || 
                              error.message?.includes("code: 0") ||
                              error.message?.toLowerCase().includes("fetch failed");
        
        if ((isQuotaError || isUnavailableError || isPermissionDeniedError || isNetworkError) && retryCount < MAX_RETRIES) {
          const canRotate = this.rotateKey(key, isQuotaError || isPermissionDeniedError);
          if (canRotate) {
            retryCount++;
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 500));
            continue;
          }
          retryCount++;
          const delay = Math.pow(2, retryCount) * 1000 + Math.random() * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }

  async translateMedicalPage(options: TranslationOptions): Promise<string> {
    const { imageBuffer, pageNumber, signal } = options;
    if (signal?.aborted) throw new Error("Translation aborted");

    const MAX_RETRIES = 5;
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      if (signal?.aborted) throw new Error("Translation aborted");
      let ai, key;
      try {
        ({ ai, key } = await this.acquireKeyAndInstance());
      } catch (e) {
        throw new Error("Không tìm thấy API Key khả dụng.");
      }

      const systemInstruction = `BẠN LÀ MỘT CHUYÊN GIA DỊCH THUẬT Y KHOA OCR. NHIỆM VỤ: Dịch Trang ${pageNumber} sang tiếng Việt.`;
      const prompt = `Dịch hình ảnh Trang ${pageNumber} sang tiếng Việt.`;

      try {
        const response = await ai.models.generateContent({
          model: this.modelName,
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: imageBuffer.split(",")[1] } }] }],
          config: { systemInstruction, temperature: 0 }
        });

        let text = response.text || "";
        return text.replace(/\.{6,}/g, '.....');
      } catch (error: any) {
        if (signal?.aborted) throw new Error("Translation aborted");
        
        const isPermissionDeniedError = error.message?.toLowerCase().includes("permission_denied") || 
                                       error.message?.toLowerCase().includes("403") ||
                                       error.message?.toLowerCase().includes("denied access");
        const isQuotaError = error.message?.toLowerCase().includes("quota") || 
                           error.message?.toLowerCase().includes("429") ||
                           error.message?.toLowerCase().includes("resource_exhausted");
        const isNetworkError = error.message?.includes("status code: 0") || 
                              error.message?.includes("code: 0") ||
                              error.message?.toLowerCase().includes("fetch failed");

        if (retryCount < MAX_RETRIES && this.rotateKey(key, isQuotaError || isPermissionDeniedError || isNetworkError)) {
          retryCount++; continue;
        }
        throw error;
      }
    }
    return "Lỗi: Quá số lần thử lại.";
  }

  async lookupMedicalTerm(term: string): Promise<any> {
    const systemInstruction = `Chuyên gia từ điển y khoa. Trả về JSON.`;
    const prompt = `Tra cứu: "${term}"`;

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
              term: { type: Type.STRING },
              definition: { type: Type.STRING },
              synonyms: { type: Type.ARRAY, items: { type: Type.STRING } },
              relatedTerms: { type: Type.ARRAY, items: { type: Type.STRING } },
              source: { type: Type.STRING }
            },
            required: ["term", "definition"]
          }
        }
      });
      return JSON.parse(response.text.replace(/```json\n?|```/g, '').trim());
    } catch (error: any) {
      throw error;
    }
  }

  async performOCR(imageBuffer: string): Promise<string> {
    let ai, key;
    try {
       ({ ai, key } = await this.acquireKeyAndInstance());
    } catch (e) {
       throw new Error("Không có API Key khả dụng.");
    }

    const systemInstruction = `OCR Y KHOA: Trích xuất văn bản chính xác.`;
    const prompt = "Hãy trích xuất văn bản từ hình ảnh này.";

    try {
      const response = await ai.models.generateContent({
        model: this.modelName,
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: imageBuffer.split(",")[1] } }] }],
        config: { systemInstruction, temperature: 0.1 }
      });
      return response.text?.trim() || "";
    } catch (error: any) {
      throw error;
    }
  }

  async *summarizeContent(content: string, type: 'page' | 'document' | 'chapter', signal?: AbortSignal): AsyncGenerator<string> {
    const systemInstruction = `BÁC SĨ CHUYÊN KHOA: Tóm tắt nội dung y khoa Markdown.`;
    const prompt = `Tóm tắt (${type}):\n\n${content}`;

    let ai, key;
    try { ({ ai, key } = await this.acquireKeyAndInstance()); } catch (e) { throw new Error("API Key error."); }

    try {
      const response = await ai.models.generateContentStream({
        model: this.modelName,
        contents: [{ parts: [{ text: prompt }] }],
        config: { systemInstruction, temperature: 0.2 }
      });
      for await (const chunk of response) {
        if (signal?.aborted) throw new Error("Aborted");
        if (chunk.text) yield chunk.text;
      }
    } catch (error: any) { throw error; }
  }
}
