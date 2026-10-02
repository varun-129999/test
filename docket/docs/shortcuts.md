# Capture from anywhere: the Docket Shortcut

One Apple Shortcut, named **Docket**, adds a task from anywhere: the Share Sheet, "Hey Siri, Docket", a home-screen widget, the Action button, or a keyboard shortcut on the Mac. It sends what you said or shared to `POST /api/quick`. Docket reads it with the same words as the `+` line in the app and adds the task, with no Claude involved. Text that starts with "ask Claude" queues a request for Claude instead.

It takes about ten minutes, once. Shortcuts syncs through iCloud, so building it on the iPhone also puts it on the Mac.

## 1. Make a capture token

The Shortcut uses its own token, not your main `DOCKET_TOKEN`. The capture token works only on `POST /api/quick` and `GET /api/quick/ping`: it can add tasks and queue requests for Claude, and it can't read, change or delete anything. If it leaks, the worst anyone can do is add tasks; make a new one and the old one stops working.

1. On the Mac, in Terminal: `openssl rand -hex 24`. Copy the result.
2. In Render, open the Docket service › **Environment** › **Add Environment Variable**: key `DOCKET_CAPTURE_TOKEN`, value the text you copied. Save. Render redeploys, which takes a minute or two.
3. Check it (paste your capture token in place of `<capture token>`):

   ```sh
   curl -H "Authorization: Bearer <capture token>" https://docket-t6dw.onrender.com/api/quick/ping
   ```

   The answer is `{"ok":true,"today":"2026-10-02"}`. A 401 means the token is wrong or the deploy hasn't finished.

Put the capture token in your password manager next to the main token. Never paste either token into a chat.

## 2. Build the Shortcut on the iPhone

Open the **Shortcuts** app, tap **+**, and name the new shortcut **Docket** (tap the name at the top). Then add these actions in order; search for each by name in the action list.

1. **Receive input.** Tap the **ⓘ** (Details) button and turn on **Show in Share Sheet**. The first action now reads "Receive … from Share Sheet". Tap the input types and keep only **Text**, **URLs** and **Safari web pages**. Tap "Share Sheet" and also tick **Quick Actions**. Set **If there's no input** to **Continue**.
2. **If.** Add **If**, and set the condition to *Shortcut Input* **has any value**.
3. Inside the If (something was shared):
   - **Get URLs from Input**, with *Shortcut Input*. Then **Set Variable**, name `link`.
   - **Ask for Input**, type Text, prompt "Add to Docket", and set its **Default Answer** to *Shortcut Input*. This lets you add "tomorrow 5pm" to a shared page's title. Then **Set Variable**, name `text`.
4. In the **Otherwise** part (run by voice or from the widget):
   - **Ask for Input**, type Text, prompt "What should I add?". When Siri runs the shortcut it asks this aloud and you answer by voice; elsewhere it shows a text field, and the keyboard's mic key dictates. Then **Set Variable**, name `text`.
5. After **End If**, add **Get Contents of URL**:
   - URL: `https://docket-t6dw.onrender.com/api/quick`
   - Tap **Show More**. Method: **POST**.
   - Headers: add one. Key `Authorization`, value `Bearer ` followed by your capture token (one space after Bearer).
   - Request Body: **JSON**. Add three Text fields: `text` = the `text` variable, `link` = the `link` variable, `source` = `shortcut`.
6. **Get Dictionary Value**: get the value for `message` in *Contents of URL*.
7. **Show Result**: *Dictionary Value*. Docket's answer is one line, for example `Added "Call Sam" for tomorrow at 17:00.`; Siri reads it out.

Run it once from the Shortcuts app to check: type `Test from the Shortcut tomorrow 5m`, and the task appears in Docket for tomorrow. Delete it afterwards.

If something goes wrong, Docket's answer has an `error` field instead of `message`, and Show Result is empty. The usual causes: a missing space after `Bearer`, the wrong token, or the URL typed with a typo.

## 3. Ways to run it

- **Siri.** Say "Hey Siri, Docket", wait for "What should I add?", then say the task: "Call Sam tomorrow at 5pm, 15 minutes, high". Siri reads back what was added.
- **Share Sheet.** In Safari, Mail, Notes or most apps, tap Share › **Docket**. A web page's link is stored on the task (a claude.ai chat or Claude Code link becomes the task's origin instead). Edit the title in the box if you like, and add a day or time.
- **Home-screen widget.** Long-press the home screen › **Edit** › **Add Widget** › **Shortcuts**, pick the small widget, then tap it and choose **Docket**. Or, in the Shortcuts app, long-press Docket › **Share** › **Add to Home Screen** for a single icon.
- **Action button** (iPhone 15 Pro and later): Settings › **Action Button** › **Shortcut** › Docket.
- **Back Tap**: Settings › Accessibility › Touch › **Back Tap** › Double Tap › Docket.
- **Mac keyboard shortcut.** Open Shortcuts on the Mac, double-click Docket, open the **ⓘ** details panel, and click **Add Keyboard Shortcut** (for example ⌃⌥D). On the Mac the Shortcut also appears under Services when you select text, because Quick Actions is ticked.

## 4. What you can say

The text goes through the same reader as the `+` line in the app. Words it recognises are taken out of the title, in any order; everything else stays in the title.

| You say | It sets |
|---|---|
| `45m`, `1h`, `1h30`, `1.5h`, `90 min`, `for 20 minutes` | estimate (default 30 minutes) |
| `today`, `tomorrow`, `tmrw`, `fri`, `on sun`, `next mon`, `next week`, `in 3 days`, `in 2 weeks`, `15 oct`, `oct 15`, `15/10`, `2026-10-15` | day (default today). A weekday is the next one ahead; `next fri` is Friday of next week |
| `due fri`, `due 15 oct` | due date instead of the day |
| `at 5pm`, `5:30pm`, `at 17:00`, `@ 9am` | time of day |
| `p1`, `p2`, `p3`, `!high`, `!low`, or `high` / `low` as the last word | priority (default med) |
| `high energy`, `low energy` | energy (default low) |
| `work`, `personal`, `health`, `#work`, `for work` | area (default Work) |
| `#Wedding`, `#"Bokaro trip"` | project |
| `daily`, `weekdays`, `weekly`, `every mon,thu`, `every 2 weeks`, `monthly`, `monthly 25`, `every month on 25`, `every 3 months` | repeat; add `after done` to count from when you finish |
| a link | the task's link |

Examples: `Call Sam fri at 5pm 15m p1`, `Book train #"Bokaro trip" due 15 oct`, `Water plants every 3 days after done`, `Gym weekdays at 7am 1h health`.

**Ask Claude.** Start with "ask Claude", "Claude," or "Claude:" ("ask Claude to draft a reply to Asha saying Thursday works") and Docket queues a request for Claude instead of adding a task. Nothing runs yet: it waits in the app under **Waiting for Claude** until you open Claude, on your plan, like any other request.

## 5. If you need to change the token

Make a new one with `openssl rand -hex 24`, replace `DOCKET_CAPTURE_TOKEN` in Render, and paste the new value into the Shortcut's Authorization header (`Bearer <new token>`). The old one stops working when Render finishes deploying. The main `DOCKET_TOKEN`, the app and the connector are not affected.

The capture token can also go in the URL (`https://docket-t6dw.onrender.com/api/quick?token=<capture token>`) for share tools that can't set headers. Prefer the header: URLs end up in logs and histories.
