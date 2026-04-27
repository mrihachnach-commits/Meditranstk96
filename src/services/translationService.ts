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
  lookupMedicalTerm?(term: string): Promise<any>;
  summarizeContent?(content: string, type: 'page' | 'document' | 'chapter', signal?: AbortSignal): AsyncGenerator<string>;
}

export type TranslationEngine = 'gemini-1.5-flash' | 'gemini-1.5-pro' | 'gemini-1.5-flash-8b';

export interface EngineConfig {
  apiKey?: string;
  modelName?: string;
}
