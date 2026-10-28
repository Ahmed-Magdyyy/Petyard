import { reportCardDto } from "./assistant.admin-cards.js";
import { reject } from "../shared/assistant.errors.js";

const copy = {
  ar: { identity: "أنا مساعد Petyard بالذكاء الاصطناعي. تفاصيل النموذج والجهة المزوّدة غير متاحة للمشاركة، وأقدر أساعدك في تقارير نشاطك على Petyard.",
    unsupported: "أقدر حاليًا أقارن إجماليات الطلبات بين شهرين، أو أعرض المنتجات الأعلى والأقل مبيعًا في شهر بالعدد أو بقيمة الأصناف المسجلة. تحب أنهي تقرير؟",
    clarify: { period: "تقصد شهر وسنة إيه؟", baseline_period: "تحب نقارن الشهر ده بأنهي شهر وسنة؟", metric: "تحب ترتيب المنتجات حسب عدد الوحدات المباعة، ولا قيمة الأصناف المسجلة؟",
      warehouse: "تقصد أنهي مخزن بالاسم أو الكود؟ ولا كل المخازن؟", request: "ممكن تحدد التقرير والشهر المطلوبين؟ أقدر أقارن شهرين أو أعرض أعلى وأقل المنتجات مبيعًا." },
    unavailable: "التقرير ده غير متاح دلوقتي.", partial: "بعض التقارير مش متاحة؛ الكروت موضحة النتيجة لكل تقرير.",
    scope: (args) => `${args.month}${args.compareTo ? ` مقارنة بـ ${args.compareTo}` : ""} — ${args.warehouse ? "المخزن المحدد" : "كل المخازن"}`,
    compare: (current, base, delta) => `إجمالي الطلبات المسجل: ${current.totalSales} مقابل ${base.totalSales}؛ الفرق ${delta}. عدد الطلبات: ${current.totalOrders} مقابل ${base.totalOrders}. متوسط قيمة الطلب: ${current.avgOrderValue} مقابل ${base.avgOrderValue}.`,
    rank: (high, metric, count, first) => `${high ? "الأعلى" : "الأقل"} مبيعًا حسب ${metric === "units" ? "عدد الوحدات" : "قيمة الأصناف المسجلة"}: ${count} منتج${first === null ? "." : `؛ قيمة أول صف ${first}.`}`,
    orderNote: "الإجماليات تشمل الطلبات غير المكتملة والتوصيل، وتستبعد الملغاة والمرتجعة. دي مش أرباح أو صافي إيراد.",
    productNote: "قيمة الأصناف = الكمية المنفذة × السعر المحفوظ في الطلب، ودي مش أرباح. الترتيب مش محسوب حسب فترات توافر المخزون.",
    lowNote: "الأقل مبيعًا تشمل المنتجات النشطة حاليًا والمضافة قبل الشهر، حتى بدون مبيعات أو بمخزون صفر؛ فلتر المخزن يعتمد على التعيين الحالي.",
    highNote: "الأعلى مبيعًا قد تشمل منتجات اتغيرت أو اتحذفت من الكتالوج.",
    currency: "المبالغ زي ما هي مسجلة، من غير فصل أو تحويل عملات.", partialMonth: "في شهر لسه مش مكتمل؛ الكارت موضح الفترة الفعلية.",
    historical: "دي لقطة محفوظة وقت إعداد التقرير؛ فتحها تاني مش بيحدّث الأرقام." },
  en: { identity: "I'm Petyard's AI business assistant. Details about the underlying model and provider are not available to share. I can help with your Petyard business reports.",
    unsupported: "I currently compare recorded order totals between two months, or rank a month's highest- and lowest-selling products by units or recorded item value. Which report would you like?",
    clarify: { period: "Which month and year do you mean?", baseline_period: "Which month and year should I compare it with?", metric: "Should I rank products by units sold or recorded item value?",
      warehouse: "Which warehouse name or code do you mean, or should I use all warehouses?", request: "Please specify the report and month. I can compare two months or rank highest- and lowest-selling products." },
    unavailable: "This report is currently unavailable.", partial: "Some reports are unavailable; each card shows its result.",
    scope: (args) => `${args.month}${args.compareTo ? ` compared with ${args.compareTo}` : ""} — ${args.warehouse ? "selected warehouse" : "all warehouses"}`,
    compare: (current, base, delta) => `Recorded order total: ${current.totalSales} versus ${base.totalSales}; difference ${delta}. Orders: ${current.totalOrders} versus ${base.totalOrders}. Average order value: ${current.avgOrderValue} versus ${base.avgOrderValue}.`,
    rank: (high, metric, count, first) => `${high ? "Highest" : "Lowest"} sellers by ${metric === "units" ? "units" : "recorded item value"}: ${count} products${first === null ? "." : `; first row value ${first}.`}`,
    orderNote: "Totals include unfinished orders and shipping, excluding cancelled/returned orders. They are not profit or net revenue.",
    productNote: "Recorded item value is fulfilled quantity × saved order-line price, not profit. Rankings do not adjust for historical stock availability.",
    lowNote: "Lowest sellers include currently active products added before the month, including zero sales and zero stock; warehouse eligibility uses current assignments.",
    highNote: "Highest sellers may include changed or deleted catalog entries.", currency: "Amounts are recorded values without currency separation or conversion.",
    partialMonth: "A month is incomplete; the card shows the actual observed period.", historical: "This is a saved snapshot. Opening it again does not refresh its figures." },
};
const number = (value) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(value);

export function renderBusinessResponse(plan, cards, config) {
  // Retained plans may still use the old label; new replies use Arabic script.
  const language = plan.language === "arabizi" ? "ar" : plan.language;
  const words = copy[language];
  if (!words) reject("invalid_admin_plan", 503);
  let text;
  let outcome = plan.outcome;
  if (outcome === "clarify") text = words.clarify[plan.clarification];
  else if (outcome !== "reports") text = words[outcome];
  else {
    const notes = new Set([words.currency, words.historical]);
    const lines = cards.map((stored) => {
      const card = reportCardDto(stored);
      const scope = words.scope(card.arguments);
      if (card.status !== "success") return `${scope}: ${words.unavailable}`;
      const data = card.data;
      if (card.tool === "compare_order_months") {
        notes.add(words.orderNote);
        if (Object.values(data.periods).some((value) => value.partial)) notes.add(words.partialMonth);
        const metrics = (value) => Object.fromEntries(Object.entries(value.metrics).map(([key, amount]) => [key, number(amount)]));
        return `${scope}: ${words.compare(metrics(data.periods.current), metrics(data.periods.baseline), number(data.changes.totalSales.absolute))}`;
      }
      notes.add(words.productNote); notes.add(card.tool === "lowest_selling_products" ? words.lowNote : words.highNote);
      if (data.period.partial) notes.add(words.partialMonth);
      const first = data.results[0];
      return `${scope}: ${words.rank(card.tool === "highest_selling_products", data.metric, data.results.length,
        first ? number(data.metric === "units" ? first.unitsSold : first.recordedItemValue) : null)}`;
    });
    const successes = cards.filter((card) => card.status === "success").length;
    if (!successes) outcome = "execution_error";
    text = [...(successes < cards.length ? [words.partial] : []), ...lines, ...(successes ? notes : [])].join("\n");
  }
  if (!text || text.length > config.maxOutputChars) reject("admin_response_too_large", 503);
  return { text, language, outcome };
}
