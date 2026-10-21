export interface AdminAsset {
  path: string;
  sha256: string;
  bytes: number;
  type: string;
  scripts: string[];
}
export interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}
