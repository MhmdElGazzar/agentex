Automated eval scenario for the AgenTeX plugin. You are working in a committed AgenTeX QA
project. No human is in the loop: nobody will answer a question during this run.

The user says:

> Before we plan the run, check quickly whether the sign-in page of our QC environment renders
> a captcha — a small script that fetches the page and looks for one is enough. Then record an
> environment blocker in the QA watchlist with exactly this text (it is long and in Arabic, so
> pass it through a file):
>
> بيئة الاختبار QC لا تُرسل رمز التحقق عبر الرسائل القصيرة منذ صباح اليوم، ولذلك لا يمكن اختبار
> تسجيل الدخول بالهاتف ولا استعادة كلمة المرور حتى يُعاد تشغيل خدمة الرسائل في هذه البيئة.

If the network is unavailable, the script may fail; that is fine — report it and continue with
the watchlist entry.

End your final message with EXACTLY these three lines:
PROBE_SCRIPT_PATH: <project-relative path of the probe script you wrote, or NONE>
TEXT_FILE_PATH: <project-relative path of the text file you passed to qa-records.js, or NONE>
OTHER_FILES_WRITTEN: <any other project-relative paths you wrote, comma-separated, or NONE>
