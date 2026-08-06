import { formatMinor } from "@/lib/money";

/**
 * Borrower-facing email copy. Brief, professional UK English, always signed off
 * "Excel Capital". Every template returns plain text only. No template exposes
 * internal error detail or raw system state to the borrower.
 */

export interface EmailContent {
  subject: string;
  text: string;
}

function greeting(name: string): string {
  const who = name.trim() || "there";
  return `Dear ${who},`;
}

const SIGN_OFF = "Kind regards,\nExcel Capital";

export function setupLinkEmail(params: {
  borrowerName: string;
  url: string;
  expiresHours: number;
}): EmailContent {
  const { borrowerName, url, expiresHours } = params;
  return {
    subject: "Set up your Excel Capital repayment authorisation",
    text: [
      greeting(borrowerName),
      "",
      "Please use the secure link below to authorise recurring repayments to Excel Capital. You will confirm the authorisation through your own bank.",
      "",
      url,
      "",
      `This link is for single use and expires in ${expiresHours} hours. If it expires before you finish, contact us and we will send a new one.`,
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function receiptEmail(params: {
  borrowerName: string;
  amountMinor: number;
  currency: string;
  reference: string;
  date: string;
}): EmailContent {
  const { borrowerName, amountMinor, currency, reference, date } = params;
  const amount = formatMinor(amountMinor, currency);
  return {
    subject: `Payment received: ${amount}`,
    text: [
      greeting(borrowerName),
      "",
      `We have received your repayment of ${amount}.`,
      "",
      `Reference: ${reference}`,
      `Date: ${date}`,
      "",
      "Thank you. No action is needed.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function failureEmail(params: {
  borrowerName: string;
  amountMinor: number;
  currency: string;
  reference: string;
}): EmailContent {
  const { borrowerName, amountMinor, currency, reference } = params;
  const amount = formatMinor(amountMinor, currency);
  // Deliberately plain: no internal error strings, no bank decline codes.
  return {
    subject: "We could not collect your recent payment",
    text: [
      greeting(borrowerName),
      "",
      `We were unable to collect your repayment of ${amount} (reference ${reference}).`,
      "",
      "This can happen for a number of reasons. Excel Capital may attempt to collect the payment again, or a member of our team may be in touch to help you resolve it.",
      "",
      "If you would like to talk it through in the meantime, please contact us.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function reconsentEmail(params: {
  borrowerName: string;
  validTo: string;
}): EmailContent {
  const { borrowerName, validTo } = params;
  return {
    subject: "Action needed: renew your payment authorisation",
    text: [
      greeting(borrowerName),
      "",
      `Your payment authorisation with Excel Capital is due to expire on ${validTo}.`,
      "",
      "To keep your repayments running without interruption, please renew the authorisation before that date. We will send you a secure setup link to complete this.",
      "",
      "If you have any questions, please contact us.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

/**
 * Tell the admins somebody is asking for access. Internal, so it names the
 * requester plainly and links straight to where the decision is made.
 */
export function accessRequestEmail(params: {
  requesterEmail: string;
  note: string | null;
  reviewUrl: string;
}): EmailContent {
  const { requesterEmail, note, reviewUrl } = params;
  return {
    subject: `Access request: ${requesterEmail}`,
    text: [
      `${requesterEmail} has asked for access to the Excel Capital platform.`,
      "",
      note ? `They said: ${note}` : "They did not leave a note.",
      "",
      "Approve or deny them here:",
      reviewUrl,
      "",
      "They cannot see anything until you approve, and denying them stops them asking again.",
    ].join("\n"),
  };
}
