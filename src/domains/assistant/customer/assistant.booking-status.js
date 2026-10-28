import { ServiceReservationModel } from "../../serviceReservation/reservations/serviceReservation.model.js";
import { serviceReservationStatusEnum } from "../../../shared/constants/enums.js";
import { getBookingProposalState } from "./assistant.booking-proposals.js";
import { assertBookingReadAccess } from "./assistant.booking-reads.js";
import { objectId } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";

const date = value => {
  const parsed = value == null ? null : new Date(value);
  if (parsed && !Number.isFinite(parsed.getTime())) reject("booking_status_unavailable", 503);
  return parsed?.toISOString() ?? null;
};
export async function getBookingLiveStatus(ownerValue, idValue, config) {
  const owner = objectId(String(ownerValue)), state = await getBookingProposalState(owner, idValue, config);
  const services = state.receipt?.result.services ?? [];
  const rows = services.length ? await ServiceReservationModel.find({ _id: { $in: services.map(service => objectId(service.reservationId)) }, user: owner })
    .select("_id status startsAt endsAt cancelledAt").limit(13).maxTimeMS(5000).lean() : [];
  const byId = new Map(rows.map(row => [String(row._id), row]));
  if (rows.length !== byId.size || rows.length > services.length) reject("booking_status_unavailable", 503);
  const reservations = services.map(service => {
    const row = byId.get(service.reservationId);
    if (!row) return { reservationId: service.reservationId, found: false, status: null, startsAt: null, endsAt: null, cancelledAt: null };
    if (!Object.values(serviceReservationStatusEnum).includes(row.status) || row.startsAt == null || row.endsAt == null || new Date(row.startsAt) >= new Date(row.endsAt)) reject("booking_status_unavailable", 503);
    return { reservationId: service.reservationId, found: true, status: row.status, startsAt: date(row.startsAt), endsAt: date(row.endsAt), cancelledAt: date(row.cancelledAt) };
  });
  await assertBookingReadAccess(owner, config);
  return { proposalId: state.proposal.id, creationStatus: state.proposal.status, dataMode: "snapshot", capturedAt: new Date().toISOString(),
    allReservationsFound: Boolean(state.receipt) && reservations.every(row => row.found), reservations };
}
