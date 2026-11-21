### Fixed

- **Non-ASCII text in database results is no longer turned into `?`.** `run_db.js` read
  sqlcmd's console output, which sqlcmd writes in the console's OEM code page (437 on an
  English Windows), so Arabic, Cyrillic, CJK and other text the page cannot hold reached the
  evidence log as `?` although the database stored it correctly. sqlcmd now writes its result
  as Unicode to a file in a fresh temp folder (`-u -o`), which the runner reads (UTF-16LE, or
  UTF-8 if a sqlcmd ignores `-u`) and removes at once. `-f o:65001` was tried and rejected: on
  Windows the first sqlcmd call of a console session still writes `?`. Row counting and the log
  format are unchanged. The manual sqlcmd fallback in the reference now uses `-u -o` too.
  Covered by two new cases in `run_db.test.js` (a fake sqlcmd; POSIX only) and checked against
  SQL Server on Windows, where the first call of a fresh session returns the Arabic text intact.
