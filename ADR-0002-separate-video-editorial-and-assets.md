---
status: accepted
---

# Separate Video editorial records from Reel assets

PetYard models a Video independently from its Reel Video Assets, with at most
one active asset used for playback. Uploads and replacements are processed as
new assets, allowing the currently published Reel to remain playable until a
replacement is ready and has the required approval; switching the active asset
is then atomic instead of overwriting published media in place.
