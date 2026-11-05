# Video craft: hook, didactics and rhythm for odoo_video

The script is the product. The recorder and the assembler only give it a
body; a flat script produces a flat video however good the pipeline is. Read
this before writing any `procedure`, `hook` or `outro`.

## 1. The hook (first 3 seconds)

`flow.hook.text` is spoken over a cold open: the END state of the flow (its
`showStep`, default the last step) with the title on screen. The viewer sees
the result before the effort. Pick ONE formula, never stack them:

- **Result first**: "Veinte segundos. Eso es todo lo que tarda ahora crear un
  contacto con su ficha completa."
- **Pain**: "¿Cuántas veces has buscado una coincidencia que ya habías
  descartado?"
- **Question + promise**: "¿Sabes por qué este botón desaparece? Te lo
  explico en un minuto."
- **Stakes**: "Si no configuras esto, tu cierre del mes sale mal."

Rules: at most 20 words (lint `HOOK-LONG`), concrete (a number, a name, a
consequence), no greeting, no "en este video vamos a ver", no channel
branding. The title card already says what the video is; the hook says why
the viewer should care.

## 2. Teach, do not read the screen

- **One idea per step.** One sentence, one thing on screen. If a step needs
  "y además", it is two steps.
- **Say why before how.** "Marcamos esta casilla para que el sistema calcule
  el precio solo" beats "Marcamos la casilla".
- **Anchor to a picture the viewer already has**: an analogy from their daily
  work ("el estado es como el semáforo del pedido"), never a generic metaphor.
- **Name what is highlighted.** Every `highlight` step says the label that is
  on screen, then what it is for, then what happens if it is left empty or
  changed. Labels come from the canon, never from memory.
- **Show the consequence.** After an action, hold on the result and narrate
  what changed (new state, new line, new total). A click with no visible
  consequence is not worth a step.
- **Cover errors on purpose.** For every action that can fail, one step shows
  the message and says how to recover. That is the part viewers rewatch.

## 3. Interaction and rhythm

- **Re-hook every ~10 seconds**: a new question, a number, a contrast ("y
  ahora lo contrario"), or a change of screen. A step that holds the same
  picture longer than its narration is a dead step: shorten the sentence or
  split the step.
- **"Ahora tú"**: at the end of a key task, one line that invites the viewer
  to pause and try it ("Pausa aquí y crea el tuyo; yo espero"), followed by a
  step with a 2-second silent hold. Use at most twice per video.
- **Vary the pace**: a fast run of short steps, then one slow step that
  carries the important rule. Never five long sentences in a row.
- **Spoken register**: at most 18 words per sentence (the lint warns at 28),
  contractions of speech, active voice, second person. Write numbers as
  words in the narration ("veinte", "tres pasos"): the voice engine reads
  digits unevenly.
- **Banned filler** (lint `FILLER`): "como pueden ver", "como vemos",
  "básicamente", "en este video vamos a ver", "as you can see".

## 4. The outro

`flow.outro.text`: one sentence that recaps the single thing to remember, and
one that points to the next video of the series by NAME ("En el siguiente,
cómo cobrar este pedido"). The assembler adds the "Next: <title>" pill, so do
not repeat the number. Last video of a series: close with the whole flow in a
sentence, not with a farewell.

## 5. A series is a path, not a pile

- Group related videos under one `group` (an app section, a role, a task
  family) and order the groups the way a newcomer needs them: overview,
  daily operations, configuration, reference, troubleshooting.
- Titles are what the viewer will search: a verb and an object ("Crear un
  contacto", "Configurar el medidor"), never "Parte 3".
- `summary` is the one-line "what you will learn" shown in the README.
- Nothing of the module may be left out: run `odoo_video operation=audit`
  and keep going until every view (new or inherited), field, button, page,
  action, workflow, automation, report, wizard and rule is narrated or has a
  reasoned `videoSkip`.
