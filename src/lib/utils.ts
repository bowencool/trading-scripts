import { OrderStatus } from "longbridge";

/** 订单不再在交易所活跃的终端状态 */
export function isTerminal(status: OrderStatus): boolean {
  return (
    status === OrderStatus.Filled ||
    status === OrderStatus.Canceled ||
    status === OrderStatus.Rejected ||
    status === OrderStatus.Expired
  );
}

export function orderStatusName(status: OrderStatus): string {
  switch (status) {
    case OrderStatus.Filled:
      return "Filled";
    case OrderStatus.Canceled:
      return "Canceled";
    case OrderStatus.Rejected:
      return "Rejected";
    case OrderStatus.Expired:
      return "Expired";
    case OrderStatus.New:
      return "New";
    case OrderStatus.PartialFilled:
      return "PartialFilled";
    case OrderStatus.NotReported:
      return "NotReported";
    default:
      return `Status(${status})`;
  }
}
