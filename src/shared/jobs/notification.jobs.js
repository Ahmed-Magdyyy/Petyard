/**
 * Notification Cron Jobs
 * 
 * 1. Reservation Reminders - 24h before appointment
 * 2. Pet Birthdays - Daily check for pet birthdays
 * 3. Expired Notification Cleanup - Clean up old notifications
 */

import cron from "node-cron";
import { ServiceReservationModel } from "../../domains/serviceReservation/reservations/serviceReservation.model.js";
import { PetModel } from "../../domains/pet/pet.model.js";
import { serviceReservationStatusEnum } from "../constants/enums.js";
import { dispatchNotification } from "../../domains/notification/notificationDispatcher.js";
import { deleteExpiredNotificationsService } from "../../domains/notification/inAppNotification.service.js";

let initialized = false;

/**
 * Send reservation reminders 24h before appointment
 * Runs every hour to catch upcoming reservations
 */
async function sendReservationReminders() {
  try {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in25Hours = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    // Find reservations starting in the next 24-25 hours that haven't been notified
    const upcomingReservations = await ServiceReservationModel.find({
      status: serviceReservationStatusEnum.BOOKED,
      startsAt: { $gte: in24Hours, $lt: in25Hours },
      user: { $exists: true, $ne: null },
      reminderSent: { $ne: true },
    })
      .select("_id user serviceName_en serviceName_ar serviceType startsAt")
      .limit(100)
      .lean();

    if (upcomingReservations.length === 0) {
      return { reminders: 0 };
    }

    let sent = 0;

    for (const reservation of upcomingReservations) {
      const serviceName = reservation.serviceName_en || reservation.serviceType;
      const startsAt = new Date(reservation.startsAt);
      const timeStr = startsAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      const dateStr = startsAt.toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
      });

      try {
        await dispatchNotification({
          userId: reservation.user,
          notification: {
            title_en: "Appointment Reminder",
            title_ar: "تذكير بالموعد",
            body_en: `Your ${serviceName} appointment is tomorrow at ${timeStr}. We look forward to seeing you!`,
            body_ar: `موعد ${serviceName} غداً الساعة ${timeStr}. نتطلع لرؤيتك!`,
          },
          icon: "appointment",
          action: {
            type: "reservation_detail",
            screen: "ReservationDetailScreen",
            params: { reservationId: String(reservation._id) },
          },
          source: {
            domain: "reservation",
            event: "reminder",
            referenceId: String(reservation._id),
          },
          channels: { push: true, inApp: true },
        });

        // Mark as reminded to avoid duplicate notifications
        await ServiceReservationModel.updateOne(
          { _id: reservation._id },
          { $set: { reminderSent: true } }
        );

        sent++;
      } catch (err) {
        console.error(
          `[notification.jobs] Failed to send reminder for reservation ${reservation._id}:`,
          err.message
        );
      }
    }

    if (process.env.NODE_ENV === "development") {
      console.log(`[notification.jobs] Sent ${sent} reservation reminders`);
    }

    return { reminders: sent };
  } catch (err) {
    console.error("[notification.jobs] Reservation reminder error:", err);
    return { error: err.message };
  }
}

/**
 * Send pet birthday notifications
 * Runs daily at 9 AM Cairo time
 */
async function sendPetBirthdayNotifications() {
  try {
    const today = new Date();
    const currentMonth = today.getMonth() + 1; // 1-12
    const currentDay = today.getDate();

    // Find pets with birthdays today (matching month and day)
    const birthdayPets = await PetModel.aggregate([
      {
        $match: {
          birthDate: { $exists: true, $ne: null },
          user: { $exists: true, $ne: null },
        },
      },
      {
        $addFields: {
          birthMonth: { $month: "$birthDate" },
          birthDay: { $dayOfMonth: "$birthDate" },
        },
      },
      {
        $match: {
          birthMonth: currentMonth,
          birthDay: currentDay,
        },
      },
      {
        $project: {
          _id: 1,
          user: 1,
          name: 1,
          type: 1,
        },
      },
      { $limit: 100 },
    ]);

    if (birthdayPets.length === 0) {
      return { birthdays: 0 };
    }

    let sent = 0;

    for (const pet of birthdayPets) {
      try {
        await dispatchNotification({
          userId: pet.user,
          notification: {
            title_en: `Happy Birthday to ${pet.name}! 🎂`,
            title_ar: `عيد ميلاد سعيد لـ ${pet.name}! 🎂`,
            body_en: `Celebrate with your furry friend! Find the perfect gift for them now.`,
            body_ar: `احتفل مع صديقك! اعثر على الهدية المثالية له الآن.`,
          },
          icon: "pet",
          action: {
            type: "screen",
            screen: "HomeScreen",
            params: {},
          },
          source: {
            domain: "pet",
            event: "birthday",
            referenceId: String(pet._id),
          },
          channels: { push: true, inApp: true },
        });

        sent++;
      } catch (err) {
        console.error(
          `[notification.jobs] Failed to send birthday notification for pet ${pet._id}:`,
          err.message
        );
      }
    }

    if (process.env.NODE_ENV === "development") {
      console.log(`[notification.jobs] Sent ${sent} pet birthday notifications`);
    }

    return { birthdays: sent };
  } catch (err) {
    console.error("[notification.jobs] Pet birthday error:", err);
    return { error: err.message };
  }
}

/**
 * Clean up expired notifications
 * Runs daily at midnight
 */
async function cleanupExpiredNotifications() {
  try {
    const result = await deleteExpiredNotificationsService();

    if (process.env.NODE_ENV === "development" && result.deletedCount > 0) {
      console.log(
        `[notification.jobs] Cleaned up ${result.deletedCount} expired notifications`
      );
    }

    return result;
  } catch (err) {
    console.error("[notification.jobs] Cleanup error:", err);
    return { error: err.message };
  }
}

/**
 * Start all notification cron jobs
 */
export function startNotificationJobs() {
  if (initialized) return;
  initialized = true;

  // Reservation reminders - every hour
  cron.schedule("0 * * * *", async () => {
    await sendReservationReminders();
  });

  // Pet birthdays - daily at 9 AM Cairo (7 AM UTC)
  cron.schedule("0 7 * * *", async () => {
    await sendPetBirthdayNotifications();
  });

  // Cleanup expired notifications - daily at midnight Cairo (10 PM UTC previous day)
  cron.schedule("0 22 * * *", async () => {
    await cleanupExpiredNotifications();
  });

  console.log("[notification.jobs] Notification cron jobs started");
}
