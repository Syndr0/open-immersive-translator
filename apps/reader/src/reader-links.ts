export interface ReaderLink {
  documentId?: string;
  targetLanguage: string;
  requestedDocument: boolean;
  invalid: boolean;
}

/** Query parameters identify local data, never an arbitrary URL or API endpoint. */
export function readReaderLink(search: string): ReaderLink {
  const parameters = new URLSearchParams(search);
  const documentId = parameters.get('document');
  const language = parameters.get('targetLanguage');
  const validId = documentId !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId);
  const validLanguage = language !== null && language.length <= 40 && /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(language);
  return {
    documentId: validId ? documentId.toLowerCase() : undefined,
    targetLanguage: validLanguage ? language : 'zh-Hans',
    requestedDocument: documentId !== null,
    invalid: (documentId !== null && !validId) || (language !== null && !validLanguage) || parameters.getAll('document').length > 1 || parameters.getAll('targetLanguage').length > 1,
  };
}
