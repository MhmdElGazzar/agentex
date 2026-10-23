### Fixed
- The settings wizard no longer deletes a plain-text value sitting under a secret user field when you save: a field you did not touch keeps its value byte-identical and is marked as plain text on disk.
- Editing or clearing the field on screen still replaces or unsets it, and `defaults.password` and secret user fields now share one keep-a-plain-value rule.
