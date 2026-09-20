export const CELESTYAL_SHIP_METADATA = {
  CJ: {
    name: "Celestyal Journey",
    totalCabins: 680,
    totalCapacity: 1360
  },
  CD: {
    name: "Celestyal Discovery",
    totalCabins: 600,
    totalCapacity: 1200
  }
};

export function getCelestyalShipMetadata(shipCode) {
  return CELESTYAL_SHIP_METADATA[shipCode] ?? null;
}
