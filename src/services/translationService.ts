export interface TranslationOptions {
  imageBuffer: string;
  textContent?: string;
  pageNumber: number;
  signal?: AbortSignal;
}

export interface TranslationService {
  translateMedicalPageStream(options: TranslationOptions): AsyncGenerator<string>;
  translateMedicalPage(options: TranslationOptions): Promise<string>;
  hasApiKey(): Promise<boolean>;
  lookupMedicalTerm?(term: string): Promise<any>;
}

export type TranslationEngine = 'gemini-flash' | 'gemini-pro' | 'medical-specialized';

export interface EngineConfig {
  apiKey?: string;
  modelName?: string;
}
