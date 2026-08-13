export interface BrandCapitalizationViolation {
  path: string;
  line: number;
  spelling: string;
  message: string;
}

export function isBrandCopySource(path: string): boolean;
export function findBrandCapitalizationViolations(
  path: string,
  source: string,
): BrandCapitalizationViolation[];
export function listBrandCopySources(repository?: string): string[];
export function checkBrandCapitalization(repository?: string): BrandCapitalizationViolation[];
