// First-launch honesty statement (prompt 08, MANIFEST.md section 6).
// Shown in English + Punjabi (Roman); a flag file in the document
// directory remembers acceptance. The document directory survives
// storage pressure (unlike cache), so the user accepts once.
import { File, Paths } from "expo-file-system";

export const DISCLAIMER_EN =
  "TheThirdEye is an assistive aid, not a medical or safety device. " +
  "It reads currency denominations and describes surroundings using AI, and it can be wrong. " +
  "It does not detect counterfeit or damaged notes. " +
  "Important amounts should be confirmed by another person. " +
  "Face recognition works only for people who have agreed to be enrolled. " +
  "TheThirdEye supports the user's own judgment and mobility aids; it does not replace them.";

export const DISCLAIMER_PA =
  "TheThirdEye ik assistive aid hai, medical ya safety device nahi. " +
  "Eh AI naal note di denomination padhda te aas-paas describe karda hai, te eh galat ho sakda hai. " +
  "Eh nakli ya fate note nahi pehchanda. " +
  "Zaroori rakam duje bande to confirm karao. " +
  "Face recognition sirf ohna lokan layi hai jina ne enroll hon layi haan kiti hai. " +
  "TheThirdEye tuhade apne judgment te mobility aids di help karda hai; ohna di jagah nahi lenda.";

function flagFile(): File {
  return new File(Paths.document, "disclaimer-accepted");
}

/** True once the user has accepted (fail-closed: errors mean "not yet"). */
export async function isDisclaimerAccepted(): Promise<boolean> {
  try {
    return flagFile().exists;
  } catch {
    return false;
  }
}

export async function acceptDisclaimer(): Promise<void> {
  await flagFile().write("1");
}
