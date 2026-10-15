# Futu desktop notification demo

The README animation shows the part that is easy to miss in a terminal transcript: you can work elsewhere while a local probe waits, Codex investigates when the condition is met, and Self-Starter can send the result as a desktop notification.

This is an edited replay of a user-provided Futu watch conversation. The request, AMD quote, sector comparison, and investigation conclusion come from that conversation. The interface and notification are illustrations, not a live capture of Codex or the operating system. Quote data is historical. Rendering the demo does not create a watch, call a model, or access a brokerage account.

## Files

- `futu-notification.gif`: looping preview embedded in the README.
- `futu-notification.mp4`: higher-quality video with the same content.
- `futu-notification.json`: curated English content without dates, clock times, user paths, credentials, or conversation identifiers.
- `render-notification.py`: the source for the animation, typography, timing, and exports.

## Render

Use Python 3 with [pycairo](https://pycairo.readthedocs.io/) and FFmpeg on your PATH. Install the Noto Sans font for the intended typography. No npm dependencies or running Self-Starter service are needed to render the media.

From the repository root:

```sh
python docs/demos/render-notification.py
```

The script replaces the GIF and MP4 beside it. It strips export timestamps, validates that the content contains no Chinese, absolute dates, clock times, private paths, or conversation links, and checks that both exports fit under 10 MB. The video is 1280 × 720, with a 30 fps MP4 and a 12 fps GIF.

## Check desktop delivery on your machine

```sh
~/.self-starter/bin/self-starter channel test desktop
```

This sends a local test notification without creating a trigger. Self-Starter uses the operating system's notification service; appearance and click behavior vary by platform. See the [guide](../guide.md) for notification setup.
