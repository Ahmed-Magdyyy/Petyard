---
status: accepted
---

# Use Bunny Stream for uploaded video media

Reels and Product Videos use a dedicated Bunny Stream Video Library for direct upload,
transcoding, and HLS delivery instead of passing video bytes through PetYard or
operating a PetYard-managed FFmpeg and CDN pipeline. PetYard retains ownership
of Reel editorial records, Product Video placements, permissions, publication
and visibility state, feed ordering, Video Saves, and playback authorization;
this keeps the product boundary in PetYard while delegating bandwidth-heavy
media processing and delivery to the provider.
