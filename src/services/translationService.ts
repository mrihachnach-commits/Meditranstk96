export interface TranslationOptions {
  imageBuffer: string;
  textContent?: string;
  pageNumber: number;
  signal?: AbortSignal;
  part?: 'top' | 'bottom' | 'full';
}

export interface TranslationService {
  translateMedicalPageStream(options: TranslationOptions): AsyncGenerator<string>;
  translateMedicalPage(options: TranslationOptions): Promise<string>;
  hasApiKey(): Promise<boolean>;
  summarizeContent?(content: string, type: 'page' | 'document' | 'chapter', signal?: AbortSignal): AsyncGenerator<string>;
}

export type TranslationEngine = 'gemini-flash' | 'gemini-pro';

export interface EngineConfig {
  apiKey?: string;
  modelName?: string;
}
