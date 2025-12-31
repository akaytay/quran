
export interface VerseIdentification {
  surahName: string;
  ayahNumber: string;
  transcription: string;
  translationEn: string;
  translationEs: string;
}

export enum AppState {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  LISTENING = 'LISTENING',
  ERROR = 'ERROR'
}

export interface TranscriptionItem {
  text: string;
  isUser: boolean;
  timestamp: number;
}
