# Reference: writing the narrated manual

Matrix of the 5 frameworks the skill applies, with THE operational rule of each
one for the agent. Write your own text: never copy text from the sources.

| Framework | What the manual takes from it | The rule for the agent |
|---|---|---|
| Diátaxis | the CONTEXT / CONFIGURE / USAGE tones | each flow declares its tone; do not mix tutorial with reference |
| Information Mapping | Procedure vs Process | the user's steps go numbered; what Odoo does behind the scenes goes as a quote |
| Minimalism (scenarios) | the user already wants something | start from the goal ("Confirm a quotation"), not from the menu |
| ISO/IEC/IEEE 26514:2022 §6.2.2, §9.14.4 | layering | safety and action information first; context after |
| OCA guides | fragment format | H2 leads (the H1 belongs to the bot), 1 sentence / 1 image, images that exist with alt |

## Storytelling applied

- **The "Record's Journey"**: the hero is the record (quotation, order),
  not Odoo and not the user. The statusbar states are its map: name the state it
  starts in and the state each button leaves it in.
- **3 acts**: I context (what this flow exists for), II usage (the
  procedure), III resolution (what happens when it fails + the error table from
  the canon).
- **6 levers**: visible goal, cost of not acting, one action per step,
  expected feedback ("Odoo shows…"), recovery, next step.
- **Tension-turn-reward**: in act III, the error is the tension, the
  recovery the turn, and the completed flow the reward.
- **StoryBrand** for CONTEXT and the index: the user is the hero; the manual is
  the guide; Odoo is the tool.
- **Lead with insight**: the first line of each section is the conclusion, not
  the preamble.
- **Gap vs gain**: the "without this / with this" contrast only counts when it
  brings a number or a label from the canon ("quedó confirmado" — "it was
  confirmed", "3 pasos menos" — "3 steps fewer"). Without data, negative
  parallelism is filler and the lint flags it.
- **Dumbify with a ceiling**: short sentences and common words, but the
  readability index cannot stay at a childlike level (ES: Fernández-Huerta < 70;
  EN: Flesch-Kincaid > 8). Clarify, do not infantilize.

## Anti-AI list (what the lint catches)

"No solo X, sino Y" without data ("not only X, but Y"); "es importante
destacar" ("it is important to note"); "en el mundo actual" ("in today's
world"); rhetorical openings; more than two em dashes per sentence; sentences
longer than 25 words. If a sentence reads like a brochure wrote it, rewrite it
the way a colleague would write it explaining in front of the screen.
