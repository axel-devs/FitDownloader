<p align="center">
<img width="128" height="128" alt="icon-128" src="https://github.com/user-attachments/assets/2321f3ab-7e7f-41d0-a200-64cd81906c05" />
</p>

## FitDownloader

FitDownloader is a simple Chrome extension that scans supported FitGirl repack pages for `fuckingfast.co` links, lets you choose which files to keep, and starts the downloads in the background with a configurable concurrency limit.

## Preview

![fitdownloader-preview](https://github.com/user-attachments/assets/61baefa5-c3d5-4110-a09e-3efab66661b9)

## Installation

1. [Download](https://github.com/axel-devs/FitDownloader/archive/refs/heads/main.zip) or clone this repository.
2. Open `chrome://extensions/` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the project root folder.

## Usage

1. Open a supported page on `fitgirl-repacks.site` that includes `fuckingfast.co` links.
2. Click the `FitDownloader` toolbar button.
3. Review the detected files and uncheck anything you do not want.
4. Use the popup selection shortcuts for quicker review: `Shift+Click` selects a range, and `Ctrl+Click` or `Cmd+Click` toggles items individually.
5. Click **Start downloads**.
6. Optional: open **Settings** in the popup to change the maximum concurrent downloads.

## Notes

- The extension only requests access to `fitgirl-repacks.site` and `fuckingfast.co`.
- Downloads run through Chrome's standard download manager.
- Chrome's **Ask where to save each file before downloading** setting still applies. Turn it off in Chrome if you want downloads to start without save prompts.
- If the target sites change their HTML structure, link detection may need to be updated.


