# PetYard Domain Context

This glossary records the canonical language used for PetYard product concepts.
It grows as feature terminology is resolved.

## Videos

**Video**:
An editorial content item in the Videos feature, independent of where its media
is hosted.
_Avoid_: Media item, video record

**YouTube Video**:
A Video whose media is hosted and played by YouTube.
_Avoid_: Normal video, external video

**Reel**:
A short-form Video uploaded manually through the Videos administration workflow
and presented in a vertically swiped viewing experience. Its source media may
be portrait or landscape; a Product Video is not a Reel.
_Avoid_: Short, YouTube Short

**Product Video**:
A video placed at the end of a product's media gallery to demonstrate the
product or how it is used. It is uploaded only while creating or editing that
product, belongs to one product, and has no independent title or description.
_Avoid_: Product clip, product media video

**Product Video Feed Entry**:
The reels-style projection of an eligible Product Video. It is not a Reel or a
separate editorial record; it uses the product's live localized titles and
ceases to exist when the product or Product Video is removed.
_Avoid_: Product-derived Reel, promoted Product Video, product Reel

**Video Asset**:
PetYard-uploaded source media and its playable derivatives. A Video Asset
belongs to either one Reel upload or one Product Video upload; it is not shared
between those content types.
_Avoid_: Video file, Bunny video

**Video Provider Operation**:
A durable obligation to verify or remove provider-hosted Video Assets after
an upload, replacement, or deletion changes their expected state.
_Avoid_: Bunny job, queue job

**Video Upload Attempt**:
A record of an attempted Reel or Product Video upload and its safe outcome,
without retaining the uploaded video itself.
_Avoid_: Upload log, Bunny log

**Video Save**:
A guest's or account user's choice to retain a Video for later viewing. Guest
and account Video Saves are distinct.
_Avoid_: Favorite, bookmark

**Saved Videos**:
The collection of Videos retained through Video Saves.
_Avoid_: Video favorites, watchlist

**Cover Image**:
The portrait image representing a Video before playback. A custom Cover Image
replaces the provider-generated thumbnail.
_Avoid_: Poster override, preview picture

**Qualified View**:
A Video playback that continues for at least two seconds.
_Avoid_: View, impression

**In-review Video**:
A Video prepared by an admin and awaiting a super-admin decision.
_Avoid_: Pending Video, submitted Video

**Approved Video**:
A Video accepted by a super admin but not necessarily public yet.
_Avoid_: Reviewed Video, accepted Video

**Published Video**:
A Video currently visible to its public audience.
_Avoid_: Active Video, live Video

**Unpublished Video**:
A formerly published Video that is currently hidden from its public audience.
_Avoid_: Disabled Video, inactive Video

**Pending Video Change**:
An administrator's proposed edit to an approved or published Video that awaits
a super-admin decision while the existing public version remains unchanged.
_Avoid_: Live edit, partially approved edit

## Customer App Layout

**Customer App Layout**:
The configuration of the customer app's Home sections and bottom navigation;
the editor also records a future chatbot-button preference.
_Avoid_: UI builder JSON, home section order

**Layout Draft**:
The unpublished Customer App Layout being edited by a super admin. Changes to
it are not shown to customers.
_Avoid_: Live layout

**Layout Publication**:
An immutable Customer App Layout version released to customer apps. A later
publication may restore the content of an earlier one without erasing history.
_Avoid_: Draft revision

**Layout Targeting**:
A rule that selects which Layout Publication a customer app receives for its
platform, app version, locale, location, and audience.
_Avoid_: Section visibility, access permission

**Promotion Visibility**:
A display condition on a promotional Home section that the customer app
evaluates from whether the viewer is a guest or signed in.
_Avoid_: Layout Targeting, access permission
