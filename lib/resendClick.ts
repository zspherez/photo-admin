const CLICKED_LINK_MAX_LENGTH = 4096;
const CLICK_UTM_MAX_LENGTH = 200;

export interface ResendClickMetadata {
  clickedLink: string | null;
  clickUtmCampaign: string | null;
  clickUtmContent: string | null;
}

function clickUtmValue(url: URL, key: string): string | null {
  const value = url.searchParams.get(key)?.trim() ?? "";
  return value &&
    value.length <= CLICK_UTM_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    ? value
    : null;
}

export function resendClickMetadata(
  eventType: string,
  click: { link?: string } | null | undefined,
): ResendClickMetadata {
  const empty = {
    clickedLink: null,
    clickUtmCampaign: null,
    clickUtmContent: null,
  };
  if (eventType !== "email.clicked") return empty;

  const link = click?.link?.trim() ?? "";
  if (
    !link ||
    link.length > CLICKED_LINK_MAX_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f]/.test(link)
  ) {
    return empty;
  }

  try {
    const url = new URL(link);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname
    ) {
      return empty;
    }
    const clickedLink = url.toString();
    if (clickedLink.length > CLICKED_LINK_MAX_LENGTH) return empty;
    return {
      clickedLink,
      clickUtmCampaign: clickUtmValue(url, "utm_campaign"),
      clickUtmContent: clickUtmValue(url, "utm_content"),
    };
  } catch {
    return empty;
  }
}
