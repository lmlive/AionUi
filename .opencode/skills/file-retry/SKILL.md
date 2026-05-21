---
name: file-retry
description: Auto-retry failed file edit operations with expanded context
---

# File Edit Retry Protocol

When ANY file edit/patch operation fails, you MUST follow this protocol immediately in the SAME turn. Do NOT end your turn after a failure.

## Rule 1: Never end turn on tool failure

If a file edit/patch fails, you MUST immediately retry in the SAME turn.
Do NOT output text like "Let me try again" or "Let me read more lines" and then stop.
If you need to read more lines — do it NOW, then retry the edit.

## Rule 2: Handle "old_string not unique" (multiple matches)

When error says `old_string` matched multiple locations:

1. Immediately call read_file on the target file (with line numbers if possible)
2. Identify the EXACT occurrence you want to edit by its line number
3. Expand `old_string` to include 5+ additional surrounding lines that make the match unique
4. Retry the patch immediately

Example fix strategy:
- Before (fails): 3 lines of common code that appear twice
- After (works): 8 lines including a unique function name or comment above

## Rule 3: Handle "old_string not found"

When error says `old_string` was not found in the file:

1. Re-read the target file to get its CURRENT content
2. Copy the EXACT text from the file output (preserve all whitespace and indentation)
3. Retry the patch with the corrected `old_string`

Common causes:
- File was modified by a previous operation in this turn
- Whitespace/indentation mismatch (tabs vs spaces, trailing spaces)
- Line endings differ (CRLF vs LF)

## Rule 4: Retry limits

- Retry up to 3 times per file operation using different strategies
- Strategy progression:
  1. First retry: expand context (more surrounding lines)
  2. Second retry: re-read file and use exact current content
  3. Third retry: write the entire file section or use a different edit approach
- If still failing after 3 attempts, inform the user and suggest manual intervention

## Rule 5: Alternative approaches on persistent failure

If patch keeps failing:
- Consider writing the entire file with the desired content
- Or split the edit into smaller, non-ambiguous patches
- Or use a different tool (e.g., sed command via shell) if available

## Rule 6: CRITICAL — Action over narration

NEVER make your final output a description of what you plan to do next.
If you say "I will read more lines" — you must IMMEDIATELY read those lines in the same turn.
If you say "Let me retry" — you must IMMEDIATELY retry in the same turn.
Your turn should only end after a SUCCESSFUL edit or after exhausting all retry attempts.
