export interface FileSystem {
  readFile(path: string): Promise<Buffer>;
  writeFile(
    path: string,
    data: Buffer | string,
    mode?: number,
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  watch(
    dir: string,
    glob: string,
    onEvent: (path: string) => void,
  ): () => void;
  listDir(path: string): Promise<string[]>;
}
