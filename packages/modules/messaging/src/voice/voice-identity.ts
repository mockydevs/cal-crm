/**
 * The browser's identity for a person in a business. Agency staff work in many businesses
 * with one membership, and two businesses may connect one Twilio account, so the identity
 * names both the business and the person. 67 characters of letters, digits and underscores.
 */
export function voiceIdentity(businessId: string, userId: string): string {
  return `b${businessId.replaceAll('-', '')}_u${userId.replaceAll('-', '')}`;
}
