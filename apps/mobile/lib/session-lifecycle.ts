let beforeChange: () => Promise<void> = async () => {};
export function setBeforeSellerSessionChange(handler: () => Promise<void>) {
  beforeChange = handler;
}
export function prepareSellerSessionChange() {
  return beforeChange();
}
