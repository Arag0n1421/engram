import test from "node:test";
import assert from "node:assert/strict";
import {explicitLotTables,modelColumnRows} from "../../src/runtime/record-tables.ts";

test("repeated positioned lot columns bind all cells and stop before footer words",()=>{
  const content=[
    "Attachment 1: Affected Lot List",
    " US Product Distribution: 04-Aug-2022 to 25-Apr-2025",
    " Expiry Date: 25-Mar-2028 or earlier",
    " Lot Number        Lot Number          Lot Number          Lot Number",
    "  AA100001          BB200002            CC300003            DD400004",
    "  AA100005          BB200006            CC300007            DD400008",
    "",
    " Northstar MedTech Corporation",
    " 3500 CORPORATE PARKWAY, CENTER VALLEY, PA 18034",
    " Page 6 of 6",
  ].join("\n");
  const tables=explicitLotTables(content),values=tables.flatMap(table=>table.values);
  assert.deepEqual(values,["AA100001","BB200002","CC300003","DD400004","AA100005","BB200006","CC300007","DD400008"]);
  assert.ok(tables.every(table=>table.values.length<=30&&table.quote.length<=1000&&table.additionalQuotes.every(quote=>quote.length<=1000)));
  for(const table of tables)for(const quote of [table.quote,...table.additionalQuotes])assert.ok(content.includes(quote));
});

test("repeated page headers continue the table while unrelated numeric columns stay excluded",()=>{
  const content=[
    "Affected units are listed below.",
    " Item Code        Pack Size          Manufacturing Date          Expiry Date        Lot Number",
    " BA10001          60                 2025-02-14                   2028-02-14          LT90001",
    " BA10002          120                2025-02-15                   2028-02-15          LT90002",
    " Page 1 of 2",
    " Item Code        Pack Size          Manufacturing Date          Expiry Date        Lot Number",
    " BA10003          60                 2025-02-16                   2028-02-16          LT90003",
    " Silverfern Medical Systems Ltd",
  ].join("\n");
  const values=explicitLotTables(content).flatMap(table=>table.values);
  assert.deepEqual(values,["LT90001","LT90002","LT90003"]);
});

test("model values come from the positioned model column and stop at the next table section",()=>{
  const content=[
    " Insulin Pump             Model Number",
    " MiniMed 640G pump        MMT-1711",
    " MiniMed 670G pump        MMT-1780",
    "",
    " Actions Required",
    " Model Number: MMT-9999",
  ].join("\n");
  assert.deepEqual(modelColumnRows(content).map(row=>row.value),["MMT-1711","MMT-1780"]);
});

test("model/catalog cells are read by column position after a product-name cell",()=>{
  const content=[
    "        Product Name         Model/Catalog Number              UDI-DI                   Lot Numbers",
    "     ViziShot 2 FLEX (19G)      NA-U403SX-4019             00821925043060           All",
    "     ViziShot 2 FLEX (20G)      NA-U403SX-4020             00821925043061           All",
    " Attachment 1: Affected Lot List",
    " Lot Number        Expiry Date",
    " KR226916           2028-04-01",
  ].join("\n");
  const rows=modelColumnRows(content);
  assert.deepEqual(rows.map(row=>row.value),["NA-U403SX-4019","NA-U403SX-4020"]);
  assert.ok(rows.every(row=>row.quote.length<=1000&&content.includes(row.quote)));
});

test("all model identifiers in one positioned table cell are retained as exact row evidence",()=>{
  const content=[
    "                 Device Family                              Model Number",
    "         Portable Controller A                  AX-1101, AX-1102, AX-1151, AX-1152",
    "         Portable Controller B                  BX-2201, BX-2202, BX-2251, BX-2252",
    " Actions Required",
    " Model Number: MMT-9999",
  ].join("\n");
  const rows=modelColumnRows(content);
  assert.deepEqual(rows.map(row=>row.value),["AX-1101","AX-1102","AX-1151","AX-1152","BX-2201","BX-2202","BX-2251","BX-2252"]);
  assert.ok(rows.every(row=>row.quote.length<=1000&&content.includes(row.quote)));
});

test("ambiguous combined model and serial or lot header cells are not typed as model identifiers",()=>{
  for(const header of ["Model / Serial Number","Model Number or Serial Number","Model Number and Lot Number"]){
    const content=[header,"MX-1101, SN-8808","MX-1201, SN-9909"].join("\n");
    assert.deepEqual(modelColumnRows(content),[],header);
  }
  const separate=[
    "Device Family               Model Number        Serial Number",
    "Family A                    MX-1101, MX-1102    SN-8808",
    "Family B                    MX-1201, MX-1202    SN-9909",
  ].join("\n");
  assert.deepEqual(modelColumnRows(separate).map(row=>row.value),["MX-1101","MX-1102","MX-1201","MX-1202"]);
});

test("mixed model and lot rows retain literal lots while placeholder All is not a lot",()=>{
  const content=[
    " Model Number           Lot Number          Expiry Date",
    " MX-410                 LOT-410             2028-04-01",
    " MX-411                 LOT-411             2028-05-01",
  ].join("\n");
  assert.deepEqual(explicitLotTables(content).flatMap(table=>table.values),["LOT-410","LOT-411"]);
  const placeholder=[
    " Product Name          Model/Catalog Number          UDI-DI           Lot Numbers",
    " ViziShot (19G)         NA-U403SX-4019                00821925043060   All",
  ].join("\n");
  assert.deepEqual(explicitLotTables(placeholder).flatMap(table=>table.values),[]);
});

test("generic perturbed spacing preserves source substrings and rejects expiry and distribution headings",()=>{
  const content="Affected lot list\n Distribution    Lot Number      Expiration Date\n US 2024         AX-12001        2028-04-01\n EU 2025         BX-12002        2028-06-01\n Contoso Medical Corporation";
  const tables=explicitLotTables(content);
  assert.deepEqual(tables.flatMap(table=>table.values),["AX-12001","BX-12002"]);
  assert.ok(tables.every(table=>[table.quote,...table.additionalQuotes].every(quote=>content.includes(quote))));
});

test("plain Lot and Batch headers retain alphabetic IDs without admitting other columns",()=>{
  const content=[
    " Affected units",
    " Lot                 Batch               Expiry Date          Pack Size",
    " LOT-ALPHA           BATCH-BETA           2028-04-01           12",
    " LOT-GAMMA           BATCH-DELTA          2028-05-01           24",
    " Cedar Bridge Devices Corporation",
  ].join("\n");
  const tables=explicitLotTables(content);
  assert.deepEqual(tables.flatMap(table=>table.values),["LOT-ALPHA","BATCH-BETA","LOT-GAMMA","BATCH-DELTA"]);
  assert.ok(tables.every(table=>[table.quote,...table.additionalQuotes].every(quote=>content.includes(quote))));
});

test("contact labels and punctuation cannot become lot IDs after token cleanup",()=>{
  const content=[
    "Product: P-1",
    "Lot Number        Expiry Date",
    "LOT1              2028-01-01",
    "Tel:              18005551234",
    "Telephone         18005551235",
  ].join("\n");
  assert.deepEqual(explicitLotTables(content).flatMap(table=>table.values),["LOT1"]);
});
