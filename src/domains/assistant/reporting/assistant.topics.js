export const TOPIC_TAXONOMY_VERSION = "petyard-topics-v1";
export const topicKeys = Object.freeze([
  "health_symptoms", "nutrition", "behavior", "grooming", "products",
  "bookings", "orders", "account_app_help", "off_topic", "unknown",
]);

export function summarizeTopics(rows, totalMessages) {
  const counts = new Map(topicKeys.map((key) => [key, 0]));
  for (const row of rows) {
    if (row._id !== "unknown" && counts.has(row._id)) counts.set(row._id, row.count);
  }
  const classifiedMessages = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const unknownMessages = totalMessages - classifiedMessages;
  counts.set("unknown", unknownMessages);
  return { taxonomyVersion: TOPIC_TAXONOMY_VERSION, assessment: "model_unreviewed",
    denominator: "retained_accepted_messages", totalMessages, classifiedMessages, unknownMessages,
    categories: [...counts].map(([key, count]) => ({ key, count,
      shareBasisPoints: totalMessages ? Math.round(count * 10000 / totalMessages) : null }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, "en")) };
}
