# Speed Savings Tracker v4

## What?
Firefox extension for tracking how much time is saved by watching HTML5 video above 1× speed.

## Why?
I frequently watch youtube videos at 2-3-4x speed because I find the normal rate of people talking annoyingly slow. In fact, most people can perceive people talking at much faster rates than they'd think -- check out [this awesome video](https://www.youtube.com/watch?v=7kAqUb3evF0) to learn more and I highly recommend trying it out yourself (it's like a muscle, the more you practice the easier it gets). Anyways, I've been doing this for a year or so now and it got me thinking: how much time have I saved by watching these videos at higher speeds (since a 10m video at 2x only takes 5m to watch)? So I vibecoded (GPT 5.4 Thinking Extended) this extension that tracks various info about your watching history, time saved, and all that. This is moreso an extension for myself, but if other people like it then that's awesome. I like data and I know I'm not alone.

## Installation
!!! Note: this is not a signed firefox extension (I am lazy and do not want to put that level of trust into GPT'd code). 

1. Disable `xpinstall.signatures.required` in `about:config` to allow unsigned extensions (dangerous!)
2. (Optional) Enable `extensions.webextensions.keepUuidOnUninstall` and `extensions.webextensions.keepStorageOnUninstall` in `about:config` so the data stays across any deletions/updates
3. Download the [extension's XPI file in the file list](https://github.com/1337isnot1337/timesave-firefox-extension/blob/main/speed-savings-tracker-v4.1.3-top-sources-scroll.xpi) (if that link doesn't work it's cause i'm too lazy to update the file just manually open it)
4. In `about:addons` click the settings button and `Install add-on from file...` and select the `speed-savings-tracker-vX.Y.Z.xpi` file
5. Install
6. ???
7. Profit!!

## Highlights
- Hardcoded tracking rule: only playback rates above 1.00× are counted
- Backward-compatible storage migration from older builds
- Source-aware analytics (individual videos/pages when details storage is enabled)
- Speed-over-time timeline chart with source-colored segments
- Top sources, top sites, recent sessions, milestones, histograms, and daily charts
- Privacy toggle for page titles/URLs
- JSON export/import and CSV reporting
