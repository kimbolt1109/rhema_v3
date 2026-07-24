Slides and media for your service go here (or import a PowerPoint deck from
inside Verger, which renders each slide to an image for you).

IMPORTANT — how Verger finds your files:

Verger resolves every slide/media file RELATIVE TO THE PLAN FILE you open.
So the simplest, most portable layout is to keep your plan next to an
"assets" folder, all inside this folder:

    my-service.json            <- your service plan
    assets\slides\slide-001.png
    assets\slides\slide-002.png
    assets\media\clip.mp4

Then in Verger:  File  >  Open Plan  >  my-service.json

Because the paths are relative, this whole folder works no matter which PC or
which drive letter you plug the USB stick into. Do NOT put absolute paths
(like C:\Users\...) into a plan — Verger rejects them on purpose.
