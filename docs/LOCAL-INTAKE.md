# Local Crew Intake

Use the local Intake dropbox to deliver text from project-local automation without starting a Pi session. This is a filesystem boundary, not a remote submission service. Configure the exact `intake.contact` in `.pi/bebop/crew.json` first; see [crew setup](CREW-INIT.md).

Write a `.draft` or temporary file under `.pi/bebop/intake/new/`, then atomically rename it to a `.md` or `.txt` file in the same directory. Do not write a final file in place.

Any trusted joined member of that exact crew may ingest the file. The configured contact determines the durable Inbox recipient, not which member ingests it. Bebop scans after membership activation and at lifecycle safe points; filesystem events only prompt a scan. Accepted files become ordinary, **unverified external-intake Follow-ups**. Delivery does not mean the contact read, classified, delegated, or acted on the content.

Private commit intents keep the original recipient across contact changes or crashes before receipt. On restart, Bebop retries a pending enqueue with the same key rather than creating a duplicate; failed files are not retried automatically. Files remain under `processed/` or `failed/` for review. See [crew setup](CREW-INIT.md) for the manifest layout.
