# TheThirdEye — Manifest

> Working name. A hands-free, proactive "second pair of eyes" for a blind shopkeeper.

---

## 1. The problem

My friend runs a small shop. He was born with one weak eye, and a brain tumour pressing on the optic nerve took almost all the sight from the other. He still opens the shop every day and still serves customers himself.

His day is full of small moments where sight matters, and he usually has no free hand to deal with them:

- **A customer hands him a note.** He has handled cash for years and can tell a lot by touch, but feel alone doesn't always tell him the denomination quickly, especially in a rush.
- **Someone walks in.** He hears the door or footsteps, but he doesn't know if it's his brother, a supplier he's expecting, a regular, or a stranger, or where in the shop they are.
- **He needs to check something.** A label on a packet, what's on the counter, where he put something. Today he has to ask someone, or pull out a phone, unlock it, open an app, point it, and wait.

Existing assistants can answer these questions, but only when he stops, picks up a phone and asks. In a working shop that is too slow and takes both hands.

> _[Placeholder: one or two sentences in his own words, recorded on 3 Nov. e.g. what he finds hardest at the counter.]_

---

## 2. Vision

TheThirdEye turns a camera and an earpiece into a quiet assistant that watches the shop *with* him. A phone on his chest (Meta glasses later) sees what he would see. An AI agent built on Meta's models decides what actually matters, and he hears a few calm words in his ear: *"Paanch sau da note."* / *"Ravi aaya hai, counter te."* / *"A man, around 30, near the door."* It speaks up when something relevant happens and stays silent the rest of the time. It answers instantly when he asks. It doesn't replace his judgment, his memory, or his cane. It gives him back the information his eyes used to give him, without needing his hands.

**Who it's for:** first and specifically, my friend, his shop, his currency (INR), his languages (Punjabi + English mix, Hindi understood). If it works for his real day, it can be extended to other blind and low-vision people who work with their hands: shopkeepers, vendors, craftspeople.

---

## 3. Principles

1. **Silence is a feature.** The default state is quiet. Every sentence it speaks must earn its place. A missed low-value event is fine; constant chatter that makes him stop listening is not.
2. **Short and calm.** Two to six words where possible. Denomination first, details only if asked. No "I can see that…", no filler.
3. **Proactive, not reactive.** It notices and tells him without being asked (a note held out, a known person arriving) and answers instantly when he does ask.
4. **Hands-free, always.** Nothing in the core loop requires touching a phone. Voice and a wake word in, earpiece out.
5. **His world, not a generic one.** It knows his shop, his people, and the current moment. It speaks his mix of Punjabi and English, and says amounts the way he says them.
6. **Never overclaim.** It says what it sees, and says "not sure" when it isn't sure. A wrong confident answer is worse than "dobara dikhao" (show again).
7. **Privacy by default.** Faces are recognised only for people who have agreed to be enrolled. Everyone else is described generically ("a woman, near the shelf") and is never identified, stored, or tracked by identity. No video is recorded; frames are processed and discarded.
8. **Support, don't replace.** His experience, his touch, his cane and the people around him stay the final authority. The tool assists his judgment.

---

## 4. What we will NOT do

- **We will not claim to detect counterfeit notes.** TheThirdEye tells him the denomination. It does not verify that a note is genuine or check it for damage. He already judges that by touch and experience.
- **We will not guarantee correctness of currency reading.** The app carries a clear disclaimer: denominations are an aid, not a verified count; anything important should be confirmed by another person.
- **We will not identify strangers.** No face search, no "who is this" for people who haven't opted in, no building profiles of customers.
- **We will not record or upload video for storage.** Frames are analysed and dropped.
- **We will not tell him it is "safe to cross" or guide him through traffic.** Mobility is safety-critical and out of scope for this hackathon. Any future mobility feature will only give awareness cues ("vehicle approaching from the left"), never permission.
- **We will not do his bill maths or run his till.** He calculates bills himself. We tell him what's in his hand; he decides what to do with it.
- **We will not make him talk to it all day.** If he has to keep asking, we've built the wrong product.

---

## 5. Why now, why us, why not Gemini / Meta AI / Be My Eyes

**Why not the existing tools?** Gemini Live, Meta AI and Be My Eyes are impressive, but they are general and **reactive**: the user has to ask, usually while holding a phone, and the assistant forgets the context once the conversation ends. That works for a curious question at home. It doesn't work behind a counter with a customer waiting and both hands busy.

| | General assistants | TheThirdEye |
|---|---|---|
| Who starts the conversation | The user, every time | The system, when something relevant happens |
| Hands | Hold a phone / tap to ask | Hands-free: chest camera / glasses + earpiece |
| Context | Forgets between questions | Knows his shop, his enrolled people, what just happened |
| Default behaviour | Talk at length when asked | Stay silent; speak in a few words when it matters |
| Language & money | Generic | INR denominations, Punjabi + English mix |

**The core idea: reactive assistants answer questions; TheThirdEye notices for you.**

**Why now?** Fast multimodal models (Meta's Muse family via the Meta Model API, and open-weight models that can run closer to the device) have made it possible to look at a live camera stream, decide what is important, and respond in about a second at a cost that works for daily use. Smart glasses with cameras and open-ear audio are becoming normal consumer hardware. The parts finally exist; what's missing is a product built around one real person's day.

**Why us?** I'm building this for a friend I've wanted to help for years, so the requirements come from his real shop, not from a persona. He is the first user and the tester. I've already shipped a live facial-recognition product (Snapbook, event photo distribution), so opt-in enrollment and real-time recognition are things I've built in production before, not a hackathon experiment.

---

## 6. Honesty statement (to appear in the app and the repo)

> TheThirdEye is an assistive aid, not a medical or safety device. It reads currency denominations and describes surroundings using AI, and it can be wrong. It does not detect counterfeit or damaged notes. Important amounts should be confirmed by another person. Face recognition works only for people who have agreed to be enrolled. TheThirdEye supports the user's own judgment and mobility aids; it does not replace them.
