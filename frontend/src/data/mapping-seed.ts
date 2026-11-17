import type { SourceRecord } from './mapping-types'

// 源记录样例：字段映射执行时逐条读取，转换结果写入字段映射结果明细。
// 规则本身来自「字段映射」模块的映射规则行（只有已启用的规则参与执行）。

function record(id: number, recordNo: string, values: Record<string, string>): SourceRecord {
  return { id, recordNo, sourceStatus: '待映射', values }
}

// 第 4、9 条是类型转换失败用例；第 1、6、7 条共用 SKU-1001；
// 第 7 条同时缺失必填价格并撞上重复键，用来核对两条冲突原因都出现。
export const MAPPING_SOURCES: SourceRecord[] = [
  record(1, 'SRC-0001', {
    商品链接: 'https://shop.example.com/item/1001',
    商品价格: '129.90',
    库存数量: '12',
    上架日期: '2026-10-01',
    商品编号: ' sku-1001 ',
    商品名称: '折叠收纳箱',
  }),
  record(2, 'SRC-0002', {
    商品链接: 'https://shop.example.com/item/1002',
    商品价格: '58',
    库存数量: '0',
    上架日期: '2026-10-02',
    商品编号: 'SKU-1002',
    商品名称: '不锈钢保温杯',
  }),
  record(3, 'SRC-0003', {
    商品链接: 'https://shop.example.com/item/1003',
    商品价格: '89.9',
    库存数量: '3',
    上架日期: '2026-10-03',
    商品编号: 'SKU-1003',
    商品名称: '硅胶折叠水壶',
  }),
  record(4, 'SRC-0004', {
    商品链接: 'https://shop.example.com/item/1004',
    商品价格: '199.00',
    库存数量: '8',
    上架日期: '2026-02-30',
    商品编号: 'SKU-1004',
    商品名称: '户外折叠椅',
  }),
  record(5, 'SRC-0005', {
    商品链接: 'https://shop.example.com/item/1005',
    商品价格: '39.5',
    库存数量: '21',
    上架日期: '2026-10-05',
    商品编号: 'SKU-1005',
    商品名称: '便携餐具套装',
  }),
  record(6, 'SRC-0006', {
    商品链接: 'https://shop.example.com/item/1006',
    商品价格: '65.00',
    库存数量: '4',
    上架日期: '2026-10-06',
    商品编号: 'SKU-1001',
    商品名称: '桌面收纳盒',
  }),
  record(7, 'SRC-0007', {
    商品链接: 'https://shop.example.com/item/1007',
    商品价格: '',
    库存数量: '',
    上架日期: '2026-10-07',
    商品编号: 'sku-1001',
    商品名称: '   ',
  }),
  record(8, 'SRC-0008', {
    商品链接: 'https://shop.example.com/item/1008',
    商品价格: '88.80',
    库存数量: '0',
    上架日期: '2026/10/08',
    商品编号: 'SKU-1008',
    商品名称: '折叠衣架',
  }),
  record(9, 'SRC-0009', {
    商品链接: 'https://shop.example.com/item/1009',
    商品价格: '面议',
    库存数量: '若干',
    上架日期: '2026-10-09',
    商品编号: 'SKU-1009',
    商品名称: '折叠水桶',
  }),
  record(10, 'SRC-0010', {
    商品链接: 'https://shop.example.com/item/1010',
    商品价格: '15',
    库存数量: '50',
    上架日期: '2026-10-10',
    商品编号: 'SKU-1010',
    商品名称: '便携雨衣',
  }),
]
