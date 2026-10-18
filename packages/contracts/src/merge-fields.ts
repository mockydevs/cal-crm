// Merge keys: the path a field or a custom value is written as inside {{…}} in a template
// or an automation step. One definition, so the settings pages that show a key, the reader
// that fills a send in (the automation module's contactValues) and the report of what no
// send can fill in (readTemplateFields) can't disagree.
import { contactMergeFields } from './message-templates.js';

/** How a field's merge key starts, by the kind of object the field belongs to. */
const OBJECT_PREFIXES: Readonly<Record<string, string>> = {
  deal: 'opportunity',
  company: 'business',
};

// contact.name, contact.email and the rest are the contact's own fields: a custom field
// with the same key never takes their place, so it is reached as contact.custom.<key> only.
const CONTACT_BUILT_INS: ReadonlySet<string> = new Set(
  contactMergeFields.map((path) => path.slice('contact.'.length)),
);

/**
 * Every path a send fills in for a contact's custom field: contact.custom.<key>, and the
 * shorter contact.<key> unless a built-in contact field already has that name.
 */
export function contactFieldPaths(key: string): string[] {
  const full = `contact.custom.${key}`;
  return CONTACT_BUILT_INS.has(key) ? [full] : [full, `contact.${key}`];
}

/**
 * A field's merge key: contact.<key>, opportunity.<key> for a deal's field, business.<key>
 * for a company's, and custom_objects.<object>.<key> for a custom object's, as GoHighLevel's
 * objects API names its properties. Null for an object it can't name: a custom one whose key
 * isn't given. It depends only on the field's key and object, which never change.
 */
export function fieldMergeKey(objectKind: string, key: string, objectKey?: string): string | null {
  if (objectKind === 'contact')
    return CONTACT_BUILT_INS.has(key) ? `contact.custom.${key}` : `contact.${key}`;
  if (objectKind === 'custom')
    return objectKey === undefined ? null : `custom_objects.${objectKey}.${key}`;
  const prefix = OBJECT_PREFIXES[objectKind];
  return prefix === undefined ? null : `${prefix}.${key}`;
}

/** A custom value's merge key. */
export function customValueMergeKey(key: string): string {
  return `custom_values.${key}`;
}

/** Every path a send fills in for a custom value: its merge key, and the older values.<key>. */
export function customValuePaths(key: string): string[] {
  return [customValueMergeKey(key), `values.${key}`];
}

/** A merge key as the text a template holds: {{contact.event_date}}. */
export function mergeToken(mergeKey: string): string {
  return `{{${mergeKey}}}`;
}

/**
 * A key made from a name, as "My Custom Value" becomes my_custom_value: lowercase letters,
 * digits and underscores, starting with a letter, at most 63 characters. A name that gives
 * no letter to start with starts with the word given instead.
 */
export function mergeKeyFromName(
  name: string,
  fallback: 'field' | 'value' | 'link' | 'object' | 'association',
): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const key = /^[a-z]/.test(slug) ? slug : slug === '' ? fallback : `${fallback}_${slug}`;
  return key.slice(0, 63).replace(/_+$/, '');
}
