declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export function getDocument(input: { data: ArrayBuffer | ArrayBufferLike }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string; text?: string }> }>;
      }>;
    }>;
  };
}
