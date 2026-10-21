# chrome-profile-names

A Claude Code mod that shows your Chrome profile names in the browser picker for the Claude in Chrome extension.

When more than one Chrome profile has the extension connected, Claude Code asks which one to use. It lists them as "Browser 1" and "Browser 2" with a device ID like `3f9c1a2e-5b7d-4c8e-9a1f-2d4b6e8c0a13`, and you have to remember which is which. Chrome already knows the profile ("Lee <lee@example.com>") and the name you typed when you paired it ("Home"). This mod puts those names in the picker instead, so you see "Home" and "Work" and pick the right one.

## How it works

The extension keeps its device ID and display name in each Chrome profile's extension settings, which is a LevelDB store on disk. The mod reads those stores itself. `hooks/leveldb.ts` is a small LevelDB reader that handles table files, the log file, and snappy-compressed blocks. `hooks/profiles.ts` walks the Chrome profiles on disk and maps each device ID to a profile. There's no subprocess and no dependency.

The mod hooks the extension's tool calls:

- `list_connected_browsers`: each "Browser N" in the result becomes the Chrome name, with a `profile` field that names the account and profile directory. A browser on another computer gets a `where` field instead. The sentence after the list gets the same names and says "selected" instead of "in use".
- `select_browser` and `switch_browser`: the confirmation names the browser the same way.
- `AskUserQuestion`: any option that names a device ID gets the Chrome name as its label, or is marked as being on another computer. The browser the session is currently using is marked selected.

A browser whose device ID isn't paired in any Chrome profile on this machine is on another computer, and the mod can't read its name from here. It's shown with what the extension does report: "another computer (macOS), connected 5 hours ago". To give it a name, put `deviceId=name` in the `remoteNames` setting in `/config`, with commas between entries. Device IDs only change when you re-pair, so that's a one-time step per machine.

If the mod can't read any Chrome profile on this machine at all, it leaves everything as it was. It doesn't guess, because a wrong name here means acting in the wrong browser.

## Install

At the prompt of a terminal session:

```
/plugin install chrome-profile-names --marketplace navels/chrome-profile-names
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install chrome-profile-names --marketplace navels/chrome-profile-names
```

In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `navels/chrome-profile-names`, then Add plugin.

The mod looks for Chrome, Chrome Beta, Chrome Canary, Chromium, Edge and Brave in their usual places on macOS, Windows and Linux.

## Development

```
claude plugin validate .
claude plugin test .
tsc -p .
```

The tests build their own LevelDB files (`hooks/fixtures.ts`), so they never read anything on your disk.
