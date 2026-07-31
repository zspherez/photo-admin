export interface OutreachClickLabelInput {
  artistName: string;
  artistCustomName: string | null;
  isFestival: boolean;
  utmCampaign: string | null;
  utmContent: string | null;
}

export function outreachClickLabel(input: OutreachClickLabelInput): string {
  if (input.isFestival && input.utmCampaign) {
    return input.utmContent
      ? `${input.utmCampaign} · ${input.utmContent}`
      : input.utmCampaign;
  }
  return input.artistCustomName?.trim() || input.artistName;
}
