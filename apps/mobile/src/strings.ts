// All user-visible UI strings, keyed by the answer-language setting.
// pa follows the design mockups (Roman code-mix); hi/en translate them.
// Greeting variants are keyed by the spoken-output script setting.
import type { SpeakLang, SpokenScript } from "../../server/src/protocol";

export interface Strings {
  connected: string;
  reconnecting: string;
  lastAnswer: string;
  listeningWord: string;
  speakingWord: string;
  cashOn: string;
  voicePa: string;
  voiceHi: string;
  voiceEn: string;
  talkTitle: string;
  talkHintTile: string;
  talkHintVolume: string;
  listeningTitle: string;
  pressAgainToSend: string;
  thinkingTitle: string;
  speakingTitle: string;
  tapToInterrupt: string;
  lookAround: string;
  lookOffHint: string;
  lookOnHint: string;
  ultraWide: string;
  cash: string;
  cashLast: string;
  cashNone: string;
  people: string;
  peopleSaved: string;
  lastHeard: string;
  nothingSaid: string;
  settings: string;
  backHome: string;
  consentSubtitle: string;
  addByVoice: string;
  addByVoiceHint: string;
  voiceExample: string;
  consentNote: string;
  savedHeading: string;
  faceSamples: string;
  removePerson: string;
  addHelper: string;
  peoplePrivacy: string;
  serverUrl: string;
  saveReconnect: string;
  answerLang: string;
  scriptName: string;
  voiceInput: string;
  onDeviceStt: string;
  serverAudio: string;
  recogLocaleIs: string;
  muteAction: string;
  unmuteAction: string;
  showCamera: string;
  ttsRate: string;
  hfovTitle: string;
  hfovAuto: string;
  langPa: string;
  langHi: string;
  langEn: string;
}

const PA: Strings = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  lastAnswer: "last answer",
  listeningWord: "listening",
  speakingWord: "speaking",
  cashOn: "₹ Cash ON",
  voicePa: "Voice: ਪੰਜਾਬੀ",
  voiceHi: "Voice: हिंदी",
  voiceEn: "Voice: English",
  talkTitle: "Gall karo",
  talkHintTile: "Talk · tap the button",
  talkHintVolume: "Talk · or press the volume key",
  listeningTitle: "Sun raha haan…",
  pressAgainToSend: "Press again to send",
  thinkingTitle: "Soch raha haan…",
  speakingTitle: "Bol raha haan",
  tapToInterrupt: "Tap to interrupt",
  lookAround: "Look around",
  lookOffHint: "Off · tap to start",
  lookOnHint: "ON · only new things",
  ultraWide: "0.6× lens",
  cash: "Cash",
  cashLast: "Last",
  cashNone: "—",
  people: "People",
  peopleSaved: "saved",
  lastHeard: "Last heard",
  nothingSaid: "Nothing said yet",
  settings: "Settings",
  backHome: "Back to home",
  consentSubtitle: "Recognised only with their consent",
  addByVoice: "Add by voice",
  addByVoiceHint: "With the person in front of the camera, say:",
  voiceExample: "“Eh banda [NAME] hai, yaad rakh”",
  consentNote: "It asks for their “haan” before saving.",
  savedHeading: "Saved",
  faceSamples: "face samples",
  removePerson: "Remove",
  addHelper: "Add with helper (5 photos)",
  peoplePrivacy: "Only face numbers are kept, never photos. Strangers are never saved.",
  serverUrl: "Server WebSocket URL",
  saveReconnect: "Save and reconnect",
  answerLang: "Answer language",
  scriptName: "Spoken script",
  voiceInput: "Voice input",
  onDeviceStt: "On-device STT",
  serverAudio: "Server audio",
  recogLocaleIs: "Recognition locale",
  muteAction: "Mute (chup)",
  unmuteAction: "Unmute (bol)",
  showCamera: "Show camera preview",
  ttsRate: "Speech rate",
  hfovTitle: "Camera field of view",
  hfovAuto: "Auto",
  langPa: "Punjabi",
  langHi: "Hindi",
  langEn: "English",
};

const HI: Strings = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  lastAnswer: "last answer",
  listeningWord: "listening",
  speakingWord: "speaking",
  cashOn: "₹ Cash ON",
  voicePa: "Voice: ਪੰਜਾਬੀ",
  voiceHi: "Voice: हिंदी",
  voiceEn: "Voice: English",
  talkTitle: "Baat karo",
  talkHintTile: "Talk · button dabao",
  talkHintVolume: "Talk · ya volume key dabao",
  listeningTitle: "Sun raha hoon…",
  pressAgainToSend: "Bhejne ke liye dobara dabao",
  thinkingTitle: "Soch raha hoon…",
  speakingTitle: "Bol raha hoon",
  tapToInterrupt: "Rokne ke liye tap karo",
  lookAround: "Look around",
  lookOffHint: "Off · shuru karne ke liye tap karo",
  lookOnHint: "ON · sirf nayi cheezein",
  ultraWide: "0.6× lens",
  cash: "Cash",
  cashLast: "Last",
  cashNone: "—",
  people: "People",
  peopleSaved: "saved",
  lastHeard: "Last heard",
  nothingSaid: "Abhi kuch nahi bola",
  settings: "Settings",
  backHome: "Back to home",
  consentSubtitle: "Sahmati se hi pehchaana jaata hai",
  addByVoice: "Add by voice",
  addByVoiceHint: "Vyakti ke camera ke saamne hone par kaho:",
  voiceExample: "“Ye [NAME] hai, yaad rakh”",
  consentNote: "Save karne se pehle unki “haan” poochta hai.",
  savedHeading: "Saved",
  faceSamples: "face samples",
  removePerson: "Remove",
  addHelper: "Add with helper (5 photos)",
  peoplePrivacy: "Sirf face numbers rakhe jaate hain, photos kabhi nahi. Anjaan log kabhi save nahi hote.",
  serverUrl: "Server WebSocket URL",
  saveReconnect: "Save and reconnect",
  answerLang: "Answer language",
  scriptName: "Spoken script",
  voiceInput: "Voice input",
  onDeviceStt: "On-device STT",
  serverAudio: "Server audio",
  recogLocaleIs: "Recognition locale",
  muteAction: "Mute (chup)",
  unmuteAction: "Unmute (bol)",
  showCamera: "Show camera preview",
  ttsRate: "Speech rate",
  hfovTitle: "Camera field of view",
  hfovAuto: "Auto",
  langPa: "Punjabi",
  langHi: "Hindi",
  langEn: "English",
};

const EN: Strings = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  lastAnswer: "last answer",
  listeningWord: "listening",
  speakingWord: "speaking",
  cashOn: "₹ Cash ON",
  voicePa: "Voice: ਪੰਜਾਬੀ",
  voiceHi: "Voice: हिंदी",
  voiceEn: "Voice: English",
  talkTitle: "Talk",
  talkHintTile: "Talk · tap the button",
  talkHintVolume: "Talk · or press the volume key",
  listeningTitle: "Listening…",
  pressAgainToSend: "Press again to send",
  thinkingTitle: "Thinking…",
  speakingTitle: "Speaking",
  tapToInterrupt: "Tap to interrupt",
  lookAround: "Look around",
  lookOffHint: "Off · tap to start",
  lookOnHint: "ON · only new things",
  ultraWide: "0.6× lens",
  cash: "Cash",
  cashLast: "Last",
  cashNone: "—",
  people: "People",
  peopleSaved: "saved",
  lastHeard: "Last heard",
  nothingSaid: "Nothing said yet",
  settings: "Settings",
  backHome: "Back to home",
  consentSubtitle: "Recognised only with their consent",
  addByVoice: "Add by voice",
  addByVoiceHint: "With the person in front of the camera, say:",
  voiceExample: "“This is [NAME], remember them”",
  consentNote: "It asks for their “yes” before saving.",
  savedHeading: "Saved",
  faceSamples: "face samples",
  removePerson: "Remove",
  addHelper: "Add with helper (5 photos)",
  peoplePrivacy: "Only face numbers are kept, never photos. Strangers are never saved.",
  serverUrl: "Server WebSocket URL",
  saveReconnect: "Save and reconnect",
  answerLang: "Answer language",
  scriptName: "Spoken script",
  voiceInput: "Voice input",
  onDeviceStt: "On-device STT",
  serverAudio: "Server audio",
  recogLocaleIs: "Recognition locale",
  muteAction: "Mute (chup)",
  unmuteAction: "Unmute (bol)",
  showCamera: "Show camera preview",
  ttsRate: "Speech rate",
  hfovTitle: "Camera field of view",
  hfovAuto: "Auto",
  langPa: "Punjabi",
  langHi: "Hindi",
  langEn: "English",
};

export const STRINGS: Record<SpeakLang, Strings> = { pa: PA, hi: HI, en: EN };

/** Spoken once per app start on the first successful connect. */
export const GREETING: Record<SpokenScript, string> = {
  latin: "Main tiyaar haan. Gall karan layi button dabao.",
  gurmukhi: "ਮੈਂ ਤਿਆਰ ਹਾਂ। ਗੱਲ ਕਰਨ ਲਈ ਬਟਨ ਦਬਾਓ।",
  devanagari: "मैं तैयार हूँ। बात करने के लिए बटन दबाओ।",
};

/** "network nahi" is already a fixed string in App; kept here for parity. */
export const NO_NETWORK: Record<SpeakLang, string> = {
  pa: "network nahi",
  hi: "network nahi",
  en: "no network",
};
