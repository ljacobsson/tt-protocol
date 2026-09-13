export async function collectPages(fetchPage) {
  const items = [];
  let startKey;
  do {
    const page = await fetchPage(startKey);
    items.push(...(page.Items || []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}
