declare module "@langchain/community/document_loaders/fs/epub" {
  export type EPubLoaderOptions = {
    splitChapters?: boolean;
  };

  export class EPubLoader {
    constructor(filePath: string, options?: EPubLoaderOptions);
    load(): Promise<Array<{ pageContent: string }>>;
  }
}
