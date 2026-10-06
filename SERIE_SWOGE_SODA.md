# SWOGE SODA — the mini-series

Viral 1-minute AI comedy shorts. Recurring cast, fixed set, one clean gag per
episode, a hook in the first 2 seconds, a twist, and a loopable button that
hands straight back into the opening frame.

> Note production : le texte montré aux joueurs et les dialogues sont en
> **anglais** (règle du dépôt). Les notes de réalisation sont ici en anglais
> aussi parce qu'elles partent telles quelles dans le prompt du moteur vidéo.

---

## The bible (do not drift)

**Premise.** SWOGE, a hyper-muscular shiba-inu bodybuilder from the year 2099
("the dog from the future"), keeps teleporting into the cramped Paris
apartment of LÉO to "fix the present" with absurd future-logic that is always
useless.

**Cast — identical look & voice in every scene, every episode:**

| Ref | Who | Look | Voice |
|---|---|---|---|
| `swoge` | **SWOGE** | Very muscular bodybuilder-build shiba inu, **furry dog paws with paw pads — NEVER human hands or fingers**, shifting futuristic tracksuit | `<AUDIO_0>` deep, calm, over-confident |
| `<IMAGE_2>` | **LÉO** | Tired, deadpan, broke 25-year-old in a hoodie, crypto-guy energy | `<AUDIO_1>` dry, flat, unimpressed |
| `<IMAGE_3>` | **BRENDA** | The smart fridge — a glowing panel, passive-aggressive | `<AUDIO_2>` flat, passive-aggressive |

**Set.** Léo's small Paris apartment — couch, desk with a glowing PC, a
kitchenette. Same set every episode.

**Running gags** (reuse, never all at once): SWOGE teleports out then re-enters
for a dumb reason ("…I forgot my keys"); "we didn't have internet in the
capsule"; SWOGE flexes when he's nervous (it reads as a lie detector); Léo's
cold coffee; BRENDA roasting them.

**Shape.** 1 minute = **4 scenes of ~15 s**. Scene 1 = cold-open hook, Scene 2
= escalation, Scene 3 = twist, Scene 4 = payoff + loopable button (last line ≈
first line).

**Generation.** Each scene ships to a video model as a *video prompt* + the
*dialogue*. Works for **xAI Grok Imagine video 1.5** (≤15 s/scene, up to 3 ref
images `<IMAGE_1..3>`, up to 3 catalogue voices `<AUDIO_0..2>`, voices baked
in) **or** for **Veo 3 / 3.1** (native synced audio, so no separate TTS). The
reference image token `swoge` is the official SWOGE image.

---

## EP 1 — "THE CRASH"

- **Logline:** A ripped shiba from 2099 teleports in to save Léo from a market crash, forgets everything he came to warn about, and the only real emergency is the oven Léo left on.
- **Hook (first 2s):** A blinding blue flash in the kitchenette; a hyper-muscular shiba in a glowing tracksuit lands in a crouch, one paw on the floor. SWOGE: "Léo. I'm from 2099. We don't have much time."

### Scene 1 — Cold-open hook
- **Beat:** SWOGE materializes mid-crouch and announces the mission. Léo doesn't look up from his PC.
- **Video prompt:** Static wide shot of a cramped Paris apartment at night, blue electric flash fills the frame, then a very muscular bodybuilder-build shiba inu (`swoge`) lands in a hero crouch with one furry paw (visible paw pads, no fingers) planted on the kitchenette floor, glowing futuristic tracksuit shifting color. Cut to tired 25-year-old in a hoodie (`<IMAGE_2>`) slouched at a desk lit by a glowing PC screen, not turning around. Cold cyan light vs warm monitor glow. SWOGE speaks (`<AUDIO_0>`), then LÉO replies flat (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Léo. I'm from 2099. We don't have much time."
  - LÉO: "You teleported into my kitchen again."
  - SWOGE: "I came to save you from the crash."

### Scene 2 — Escalation
- **Beat:** SWOGE builds up the dire warning, then admits he can't remember any of it. He flexes to cover the nerves.
- **Video prompt:** Medium two-shot, SWOGE standing over the desk gesturing with a thick furry paw (paw pads visible, never hands), Léo spinning his chair to face him deadpan. SWOGE's smile cracks; he nervously flexes both arms, tracksuit straining. Warm desk lamp, PC glow. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "In the future, everything collapses because of one tiny mistake you make — tonight."
  - LÉO: "Which is?"
  - SWOGE: "...I forgot. We didn't have internet in the capsule." (flexes)

### Scene 3 — Twist
- **Beat:** BRENDA the fridge calmly points out the apartment is literally filling with smoke. The real disaster isn't the market — it's the oven.
- **Video prompt:** Push-in on a smart fridge with a glowing panel (`<IMAGE_3>`) as thin smoke drifts across the kitchenette. SWOGE and Léo both turn toward a glowing oven. Orange emergency glow mixes with cyan. BRENDA voice from the panel (`<AUDIO_2>`), SWOGE keeps one paw raised (paw pads, no fingers).
- **Dialogue:**
  - BRENDA: "Not to interrupt the hero speech, but the oven has been on for six hours."
  - LÉO: "...Oh. That's the crash."
  - SWOGE: "The future is saved. By me."

### Scene 4 — Payoff + loopable button
- **Beat:** Léo switches off the oven. SWOGE declares mission accomplished, teleports out in a flash — then pops right back for his keys.
- **Video prompt:** Léo reaches past SWOGE and flips the oven knob; SWOGE strikes a victory flex. Blue flash — SWOGE vanishes. One beat of empty kitchen. Second blue flash — SWOGE reappears in the same hero crouch, one furry paw on the floor (paw pads, no fingers), sheepish. Match the exact framing of Scene 1 for the loop. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Mission accomplished. See you never, Léo." (vanishes)
  - SWOGE: (reappears) "...I forgot my keys."
  - LÉO: "You don't have pockets."
- **Caption + hashtags:** The dog from the future came to save me and turned off my oven. #swogesoda #dogfromthefuture #shibainu #aicomedy #2099 #sitcom
- **Why it loops / why it's shareable:** The final re-entry crouch matches the opening frame exactly, so the flash loops seamlessly into "I'm from 2099" — and everyone has left an oven on.

---

## EP 2 — "THE PASSWORD"

- **Logline:** SWOGE insists he can recover Léo's lost crypto wallet with unbeatable future-security, which turns out to be shouting the password at the screen.
- **Hook (first 2s):** Blue flash in the kitchenette; SWOGE lands in the hero crouch, one furry paw down. SWOGE: "Léo. Your fortune is in danger. I'm from 2099."

### Scene 1 — Cold-open hook
- **Beat:** SWOGE arrives claiming he's here to rescue Léo's locked crypto wallet. Léo is already staring, defeated, at a wallet login screen.
- **Video prompt:** Static wide of the dark apartment, blue electric flash, muscular shiba (`swoge`) lands in the exact Episode-1 hero crouch, one furry paw (paw pads, no fingers) on the kitchenette floor, glowing tracksuit. Cut to Léo (`<IMAGE_2>`) hunched at the desk, PC showing a generic wallet "ENTER PASSWORD" screen, cold coffee mug beside the keyboard. Cyan flash light, warm monitor glow. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Léo. Your fortune is in danger. I'm from 2099."
  - LÉO: "I locked myself out of my wallet. Can you actually help?"
  - SWOGE: "In the future, passwords are obsolete. We solved security."

### Scene 2 — Escalation
- **Beat:** SWOGE boasts about flawless future-tech while being physically unable to type with paws. He flexes to hide it.
- **Video prompt:** Medium shot, SWOGE at the keyboard mashing it with two big furry paws (paw pads clearly visible, no fingers), keys doing nothing useful, Léo watching deadpan over his shoulder. SWOGE straightens and flexes nervously, tracksuit shifting color. Desk lamp warm, PC glow. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Watch. 2099 encryption. Unbreakable."
  - LÉO: "You have paws. You can't type."
  - SWOGE: "A warrior does not need fingers." (flexes, hits twelve keys at once)

### Scene 3 — Twist
- **Beat:** SWOGE reveals the "future method": you simply tell the computer the password out loud. BRENDA judges. It somehow works.
- **Video prompt:** Push-in on SWOGE leaning toward the glowing PC screen, chest puffed, one furry paw raised (paw pads, no fingers). BRENDA's fridge panel (`<IMAGE_3>`) glows in the background. The screen flips from red "LOCKED" to green "UNLOCKED." Cyan-green glow. SWOGE (`<AUDIO_0>`), BRENDA (`<AUDIO_2>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "In 2099 you simply ASK the machine. Computer: the password is 'shiba123'."
  - BRENDA: "He said your password out loud. In a video."
  - LÉO: "...It unlocked. How did that—"

### Scene 4 — Payoff + loopable button
- **Beat:** The wallet shows a balance of basically nothing. SWOGE claims victory, teleports out, pops back because he said the password on camera.
- **Video prompt:** Close on PC screen: balance "$4.12." Léo's face falls flat; SWOGE victory-flexes anyway. Blue flash — SWOGE vanishes. Empty kitchen beat. Second blue flash — SWOGE reappears in the same hero crouch, one furry paw down (paw pads, no fingers), matching Scene 1 framing exactly. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Your fortune is restored. Four dollars. I'm from 2099." (vanishes)
  - SWOGE: (reappears, crouched) "...I said the password on camera, didn't I."
  - LÉO: "Everyone heard it."
- **Caption + hashtags:** Hired the dog from the future to recover my crypto. He said my password out loud. #swogesoda #dogfromthefuture #crypto #aicomedy #shibainu #passwordfail
- **Why it loops / why it's shareable:** The ending crouch drops straight into the opening "your fortune is in danger" line, and every crypto person has felt that $4.12 gut-punch.

---

## EP 3 — "THE DATE"

- **Logline:** SWOGE teleports in to coach Léo through a video date using "proven 2099 romance data," which is just flexing until the date leaves.
- **Hook (first 2s):** Blue flash; SWOGE lands in the hero crouch, one furry paw down, mid-sentence. SWOGE: "Léo. Do not open that message. I'm from 2099."

### Scene 1 — Cold-open hook
- **Beat:** SWOGE arrives warning Léo about a message — it's a girl asking him on a video call in ten minutes. SWOGE appoints himself love coach.
- **Video prompt:** Static wide of the dark apartment, blue flash, muscular shiba (`swoge`) lands in the identical hero crouch, one furry paw (paw pads, no fingers) on the kitchenette floor. Cut to Léo (`<IMAGE_2>`) at the desk, phone glowing with a chat bubble, cold coffee on the table. Cyan flash plus warm phone glow. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Léo. Do not open that message. I'm from 2099."
  - LÉO: "It's a girl. She wants to video call. In ten minutes."
  - SWOGE: "Then you need me. I have the romance data."

### Scene 2 — Escalation
- **Beat:** SWOGE "coaches" by making Léo flex and recite a cringe future pickup line. Léo refuses; SWOGE demonstrates on himself.
- **Video prompt:** Medium two-shot, SWOGE posing with a huge flex, demonstrating to Léo who stays slumped and unimpressed. SWOGE gestures with a thick furry paw (paw pads, no fingers), tracksuit shifting. Warm lamp light. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Statistically, romance is 80% delts. Flex and say: 'I have optimized myself for you.'"
  - LÉO: "I'm not saying that."
  - SWOGE: "Fine. I'll demonstrate." (flexes directly into the webcam)

### Scene 3 — Twist
- **Beat:** The call connects early — and the girl can only see SWOGE, a giant flexing shiba filling the frame. BRENDA narrates the disaster.
- **Video prompt:** Over-the-shoulder of the PC: a video-call window shows a confused woman's face; the webcam feed is entirely a muscular shiba (`swoge`) mid-flex, furry paws up (paw pads, no fingers), chest filling the frame. Léo dives sideways out of shot. BRENDA panel (`<IMAGE_3>`) glows. Cool screen light. SWOGE (`<AUDIO_0>`), BRENDA (`<AUDIO_2>`), LÉO (`<AUDIO_1>`, off-frame).
- **Dialogue:**
  - SWOGE: "Greetings. I have optimized myself for you."
  - BRENDA: "She is leaving the call. She has left the call."
  - LÉO: (off-frame) "SWOGE. That was her."

### Scene 4 — Payoff + loopable button
- **Beat:** The call ends. SWOGE declares the date a success, teleports out, pops back because he needs to check one thing.
- **Video prompt:** Close on PC: "CALL ENDED." Léo face-down on the desk; SWOGE victory-flexes behind him. Blue flash — SWOGE vanishes. Empty-kitchen beat. Second blue flash — SWOGE reappears in the exact Scene 1 hero crouch, one furry paw down (paw pads, no fingers), matching framing for the loop. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Love achieved. You're welcome. I'm from 2099." (vanishes)
  - SWOGE: (reappears, crouched) "...Did she say yes or did she block you?"
  - LÉO: "Get out."
- **Caption + hashtags:** Let the dog from the future coach my first date. He flexed into the webcam. #swogesoda #dogfromthefuture #datingfail #aicomedy #shibainu #webcamfail
- **Why it loops / why it's shareable:** The closing crouch cuts right back into "do not open that message," and the webcam-takeover is the universal fear of a video call going wrong.

---

## EP 4 — "THE SOULMATE SPOILER"

- **Logline:** SWOGE swears he's seen Léo's future soulmate but refuses to say who, so Léo spends the day accusing everyone he knows.
- **Hook (first 2s):** Close on SWOGE's paw slamming a photo face-down on the desk. SWOGE: "I've met your wife. I can't tell you who."

### Scene 1 — Cold-open hook
- **Beat:** SWOGE teleports in mid-flex and immediately announces he knows Léo's future soulmate. He will NOT say who. Léo, holding cold coffee, is not moved.
- **Video prompt:** Medium shot in cramped Paris apartment, warm desk-lamp glow. SWOGE (`swoge`), muscular shiba inu in a shimmering tracksuit, presses one furry paw with paw pads flat on a face-down photo on the desk — clearly paws, no fingers. Léo (`<IMAGE_2>`) sits on the couch holding a mug, deadpan. Handheld, slight push-in on SWOGE. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "I've met your wife. In 2099. Beautiful. Terrifying grip."
  - LÉO: "Cool. Who is it."
  - SWOGE: "Spoilers collapse timelines, Léo. Also I promised her."

### Scene 2 — Escalation
- **Beat:** Léo starts guessing. Every name he says, SWOGE reacts with a tiny involuntary tell — and flexes to cover it. Léo clocks the flexing as a lie detector.
- **Video prompt:** Two-shot, Léo leaning forward off the couch, SWOGE standing by the kitchenette. Each time Léo names someone, SWOGE's eye twitches and he does a sudden bicep flex, fur rippling, paws clenched (paw pads visible, no hands). Fast comedic cutting on each guess, lamp light. LÉO (`<AUDIO_1>`), SWOGE (`<AUDIO_0>`).
- **Dialogue:**
  - LÉO: "Is it Camille?" SWOGE: *(flex)* "No comment."
  - LÉO: "The barista?" SWOGE: *(bigger flex)* "I am simply warming up."
  - LÉO: "You flex when you lie. I can see it."

### Scene 3 — Twist
- **Beat:** BRENDA, tired of it, "helpfully" reveals that SWOGE never actually saw a face — he saw a reflection. In a soda can. Of Léo.
- **Video prompt:** Close on the fridge's glowing panel (`<IMAGE_3>`, BRENDA) pulsing as she speaks, then whip-pan to SWOGE freezing mid-flex, guilty. Kitchenette light, cool blue from the panel. BRENDA (`<AUDIO_2>`), SWOGE (`<AUDIO_0>`).
- **Dialogue:**
  - BRENDA: "Correction. His 'soulmate' footage is one frame. It is a soda can. Reflecting Léo."
  - SWOGE: *(frozen flex)* "...The capsule had bad resolution."
  - LÉO: "So my soulmate is me."

### Scene 4 — Payoff + loopable button
- **Beat:** SWOGE recovers with total confidence, hands Léo a SWOGE SODA, toasts "self-love." Léo sips, it's warm. SWOGE teleports out — then pops back in: "...I still can't tell you who."
- **Video prompt:** SWOGE confidently places a can of SWOGE SODA in Léo's hand, then flexes a toast. Teleport flash (blue particle burst), SWOGE gone. Beat. Second flash, SWOGE's head pokes back through, one furry paw on the frame (paw pads, no fingers). Loop-friendly framing matching the opening. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "The future wants you to love yourself. Drink."
  - LÉO: *(sips)* "It's warm."
  - SWOGE: *(teleports, pops back)* "...I still can't tell you who."
- **Caption + hashtags:** POV: your dog from the future won't tell you who you marry 😭 #swogesoda #dogfromthefuture #aivideo #shiba #pov #comedy
- **Why it loops / why it's shareable:** The last line is the first line, so it restarts seamlessly; "your soulmate is you" is a tag-a-friend trap.

---

## EP 5 — "3AM FUTURE-THERAPY"

- **Logline:** SWOGE catches Léo doom-spiraling at 3am and "fixes" overthinking with increasingly unhinged future-therapy.
- **Hook (first 2s):** Pitch-dark room, only Léo's face lit by his phone. A teleport flash. SWOGE, fully awake and oiled: "The future detected cortisol."

### Scene 1 — Cold-open hook
- **Beat:** 3am. Léo lies awake spiraling. SWOGE teleports in, glistening, mid-workout, announces the future "pinged" Léo's anxiety.
- **Video prompt:** Dark apartment, Léo (`<IMAGE_2>`) on the couch lit only by phone glow, eyes wide. Sudden blue teleport flash reveals SWOGE (`swoge`), muscular shiba inu, sweat-sheen, tracksuit half-on, standing over him. Low angle, dramatic. Furry paws with paw pads — no hands. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "The future detected cortisol. I came."
  - LÉO: "It's 3am. What are we even doing."
  - SWOGE: "Exactly what she'll ask in the deposition."

### Scene 2 — Escalation
- **Beat:** SWOGE's "therapy": he makes Léo rate his fear 1–10, then reveals in 2099 the scale "goes to 40" so a 7 is "basically fine." The math makes Léo more anxious.
- **Video prompt:** SWOGE sits cross-legged on the floor like a guru, one paw raised (paw pads visible, no fingers). Léo wrapped in a blanket beside him. Warm phone glow plus faint blue tracksuit light. Slow comedic zoom on Léo's dead eyes. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Rate the dread. One to ten."
  - LÉO: "...A seven?"
  - SWOGE: "In 2099 the scale goes to forty. You're thriving."
  - LÉO: "Why does forty exist. What happens."

### Scene 3 — Twist
- **Beat:** SWOGE confidently offers "the future breathing technique." It's just normal breathing. BRENDA points out he's describing breathing. SWOGE, nervous, flexes.
- **Video prompt:** SWOGE demonstrates "advanced" breathing, chest puffing, paws spread wide (paw pads, no fingers). Fridge panel (`<IMAGE_3>`, BRENDA) glows and cuts in. SWOGE's demo stutters, he flexes to cover embarrassment, fur rippling. Cool-dark room, blue panel glow. SWOGE (`<AUDIO_0>`), BRENDA (`<AUDIO_2>`).
- **Dialogue:**
  - SWOGE: "Inhale the timeline. Hold. Release the timeline."
  - BRENDA: "That is breathing. You invented breathing."
  - SWOGE: *(flex)* "We refined it."

### Scene 4 — Payoff + loopable button
- **Beat:** It somehow works — Léo yawns, calm. SWOGE declares victory, teleports out. Instantly Léo's phone buzzes; he spirals again. Teleport flash — SWOGE returns, equally fresh: "The future detected cortisol."
- **Video prompt:** Léo finally relaxes, eyelids drooping, phone on his chest. SWOGE flexes a proud farewell, teleports out (blue burst). Phone screen lights up Léo's wide eyes again. Second teleport flash, SWOGE back over him identical to the open. Match opening framing for loop. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Anxiety: defeated. I return to 2099."
  - LÉO: *(phone buzzes, eyes snap open)* "...oh no."
  - SWOGE: *(teleports back in)* "The future detected cortisol."
- **Caption + hashtags:** when your 3am brain gets a personal trainer 💀 #swogesoda #3am #overthinking #dogfromthefuture #aivideo #relatable
- **Why it loops / why it's shareable:** The phone-buzz restart maps onto everyone's real 3am loop; "the scale goes to 40" is an instant quotable comment-bait.

---

## EP 6 — "LOOK RICH DOT FUTURE"

- **Logline:** SWOGE coaches Léo to look successful online with future "flex-tech," and it spectacularly outs how broke he is.
- **Hook (first 2s):** Phone held vertical filming Léo. SWOGE's paw shoves a rented gold chain into frame. SWOGE: "Today we fake generational wealth."

### Scene 1 — Cold-open hook
- **Beat:** SWOGE appoints himself Léo's social media coach. Goal: make Léo look rich. He drapes him in props.
- **Video prompt:** Vertical-phone-within-the-shot vibe in the apartment, bright ring-light look. SWOGE (`swoge`) uses furry paws (paw pads, no hands) to drape a too-big gold chain on Léo (`<IMAGE_2>`), who sits unimpressed on the couch. Clean bright lighting vs cramped messy background. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Today we fake generational wealth."
  - LÉO: "That chain is from the kitchen drawer."
  - SWOGE: "In 2099 perception IS currency. Pose."

### Scene 2 — Escalation
- **Beat:** SWOGE stages a "luxury" photo: angles the phone so the kitchenette looks like a mansion, calls the cold coffee an "artisan cortado," flexes as the backdrop.
- **Video prompt:** SWOGE crouches holding the phone with both paws (visibly paws, paw pads, no fingers), framing Léo against the kitchenette. Léo holds the old mug of cold coffee. SWOGE flexes to be "the aesthetic." Fast, glossy "content" cuts, bright. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`).
- **Dialogue:**
  - SWOGE: "Hold the artisan cortado. It reads wealthy."
  - LÉO: "It's three-day-old coffee."
  - SWOGE: "The future doesn't taste it, Léo. It SEES it."

### Scene 3 — Twist
- **Beat:** They post it. BRENDA reads the top comment aloud: everyone recognizes the exact apartment and the dollar-store chain — Léo's now famous for being broke. SWOGE insists this is "good engagement."
- **Video prompt:** Close on glowing PC screen showing the posted photo and a flood of comments; whip to BRENDA's panel (`<IMAGE_3>`) glowing as she reads. SWOGE in background, smile stiffening, starting to flex nervously (paws clenched, paw pads, no fingers). Screen glow + blue panel. BRENDA (`<AUDIO_2>`), SWOGE (`<AUDIO_0>`).
- **Dialogue:**
  - BRENDA: "Top comment: 'bro that's the drawer chain and a studio flat.' Forty thousand likes."
  - SWOGE: *(flex)* "Virality. We won."
  - LÉO: "I'm trending for being poor."

### Scene 4 — Payoff + loopable button
- **Beat:** SWOGE "fixes" it with a follow-up "humble" post — which accidentally films the eviction notice on the fridge. BRENDA judges. SWOGE teleports out, pops back: "In 2099 you're a lifestyle brand."
- **Video prompt:** SWOGE films a second vertical "humble post," paw holding the phone (paw pads, no fingers), but the shot catches a paper notice stuck to the fridge. BRENDA's panel pulses disapproval. Léo covers his face. SWOGE teleports out (blue burst), pops back in mid-flex. Match the bright coaching framing of the opening for the loop. SWOGE (`<AUDIO_0>`), LÉO (`<AUDIO_1>`), BRENDA (`<AUDIO_2>`).
- **Dialogue:**
  - SWOGE: "Now we post 'humble.' Authenticity sells."
  - BRENDA: "You just filmed the eviction notice."
  - SWOGE: *(teleports, pops back, flexing)* "In 2099 you're a lifestyle brand."
- **Caption + hashtags:** how to look rich online (do NOT trust the dog) 💸 #swogesoda #fakeituntil #dogfromthefuture #aivideo #broke #comedy
- **Why it loops / why it's shareable:** "Trending for being poor" is painfully relatable rage-bait; the button relaunches the exact doomed coaching premise.

---

## Virality & distribution playbook

**Platforms & format.** Post native 9:16 vertical, 1080x1920, to TikTok, Reels,
and YouTube Shorts simultaneously — never cross-post with a visible watermark
(each platform throttles competitors' logos). Keep every episode ~60s. Export
once clean, re-upload per platform with platform-native captions burned in
(~85% of autoplay is muted — on-screen text is non-negotiable, and it's already
all in English).

**Cadence.** Ship on a fixed rhythm: 3 episodes/week (e.g. Mon/Wed/Fri) at the
same local time so the algorithm and the audience both learn the schedule.
Batch-generate so you always keep a 2-week buffer; consistency beats perfection
for a sitcom.

**The first-2-seconds rule.** Open on motion + a claim, never a logo or a title
card. Each episode leads with SWOGE's paw-slam / teleport flash / shoved prop
plus the first spoken line. The hook IS the thumbnail frame. No intro, no "hey
guys" — the gag starts on frame one.

**Use the loop.** Every Scene-4 button hands back into Scene 1 (last line = first
line, or a phone-buzz / teleport-return that resets the premise). A seamless
loop pushes average-watch-time past 100%, the strongest ranking signal on all
three platforms. No end card on the loop; let it run into the restart, with only
a tiny corner bug "SWOGE SODA • Ep N".

**Series-binding.** Treat the button as a soft cliffhanger that keeps the premise
re-fireable. Pinned text: "Ep [N+1] drops [day]." Build a playlist/collection
("SWOGE SODA — all episodes") and pin it so one viewer binges the backlog.

**Comment-bait (one per episode, baked into the script).** Ep4 "so my soulmate is
me" → pin "tag who the dog actually saw". Ep5 "the scale goes to 40" → pin
"what's YOUR number out of 40?". Ep6 "trending for being poor" → pin "rate
SWOGE's coaching 1–10". Pin one leading question within 5 minutes of posting;
reply to early comments in SWOGE's deep over-confident voice to extend session
time.

**The duet/stitch template — the real growth engine.** Package the premise so
others can copy it: *"My dog from the future shows up to 'fix' [X] with useless
future-logic."* Leave a 2-second reaction gap at the hook so stitchers can cut in.
Post occasional open-prompt episodes ("reply with a problem, SWOGE fixes it in
2099") to farm duets. Keep the fixed recognizable unit — muscular shiba, paws not
hands, teleport flash, warm useless advice, flex-when-nervous — so any parody
still reads as SWOGE. Caption formula: "POV: your dog from the future won't shut
up about [topic]."
