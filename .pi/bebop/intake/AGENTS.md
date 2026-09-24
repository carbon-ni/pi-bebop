# Crew Intake dropbox

This directory is an external transport boundary, not the crew Inbox. Put a file here only when an outside agent needs to submit context for the configured Intake contact.

## Publish one file

- Write only a non-empty UTF-8 `.md` or `.txt` file no larger than 997,952 UTF-8 bytes, with a filename no longer than 160 UTF-8 bytes, as a direct child of `.pi/bebop/intake/new/`.
- Keep this guide and the source file outside `.pi/bebop/intake/new/`; Intake scans only direct children there.
- Write to a unique `.draft` file, flush and fsync it while open, close it, then atomically rename it into `.pi/bebop/intake/new/`.
- Never overwrite an existing name. Use a new unique filename for every publication.

## Do not touch

Never write, rename, delete, or edit `.pi/bebop/intake/processed/`, `.pi/bebop/intake/failed/`, `.pi/bebop/intake/receipts/`, `.pi/bebop/intake/commits/`, `.pi/bebop/intake/.scan.lock`, `.pi/bebop/sockets/`, or `.pi/bebop/inbox/`. Those paths are managed by Bebop.

Movement into `.pi/bebop/intake/processed/` is transport evidence only. It does not prove that the content was read, understood, acted on, or completed.
