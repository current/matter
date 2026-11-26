// Renders SF Symbols to SVG path data on the build Mac, so the glyphs come from the system and are
// never committed. Usage: swift extract-sf-symbols.swift <pointSize> <name>... > symbols.json
// SwiftUI's ImageRenderer keeps symbols as vector paths in a PDF; slashed symbols cut their gap
// with a luminosity soft mask, which becomes an SVG mask.
import AppKit
import SwiftUI

struct Affine {
  var a = 1.0, b = 0.0, c = 0.0, d = 1.0, e = 0.0, f = 0.0
  func apply(_ x: Double, _ y: Double) -> (Double, Double) { (a * x + c * y + e, b * x + d * y + f) }
  func concat(_ m: Affine) -> Affine {
    Affine(
      a: m.a * a + m.b * c, b: m.a * b + m.b * d, c: m.c * a + m.d * c, d: m.c * b + m.d * d,
      e: m.e * a + m.f * c + e, f: m.e * b + m.f * d + f)
  }
}

struct Fill: Encodable {
  let d: String
  let evenOdd: Bool
  let gray: Double
  var mask: Mask?
}

/// A soft mask: luminance of `fills` painted over `backdrop`, or their coverage when `alpha`.
struct Mask: Encodable {
  let alpha: Bool
  let backdrop: Double
  let fills: [Fill]
}

func num(_ v: Double) -> String {
  let r = (v * 100).rounded() / 100
  return r == r.rounded() ? String(Int(r)) : String(r)
}

func streamText(_ s: CGPDFStreamRef) -> String {
  var format = CGPDFDataFormat.raw
  return String(data: CGPDFStreamCopyData(s, &format)! as Data, encoding: .isoLatin1) ?? ""
}

func subDict(_ dict: CGPDFDictionaryRef?, _ key: String) -> CGPDFDictionaryRef? {
  guard let dict else { return nil }
  var out: CGPDFDictionaryRef?
  return CGPDFDictionaryGetDictionary(dict, key, &out) ? out : nil
}

func stream(_ dict: CGPDFDictionaryRef?, _ key: String) -> CGPDFStreamRef? {
  guard let dict else { return nil }
  var out: CGPDFStreamRef?
  return CGPDFDictionaryGetStream(dict, key, &out) ? out : nil
}

func matrix(_ dict: CGPDFDictionaryRef) -> Affine {
  var array: CGPDFArrayRef?
  guard CGPDFDictionaryGetArray(dict, "Matrix", &array), let array, CGPDFArrayGetCount(array) == 6
  else { return Affine() }
  var v = [CGPDFReal](repeating: 0, count: 6)
  for i in 0..<6 { CGPDFArrayGetNumber(array, i, &v[i]) }
  return Affine(a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5])
}

/// Walks a content stream, emitting each fill in page space (y flipped to SVG's top-left origin).
func walk(
  _ content: String, resources: CGPDFDictionaryRef?, ctm start: Affine, height: Double,
  emit: (Fill) -> Void
) {
  var ctm = start
  var gray = 0.0
  var mask: Mask? = nil
  var stack: [(Affine, Double, Mask?)] = []
  var operands: [String] = []
  var path = ""
  func point(_ x: Double, _ y: Double) -> String {
    let (px, py) = ctm.apply(x, y)
    return "\(num(px)) \(num(height - py))"
  }
  func n(_ i: Int) -> Double { Double(operands[operands.count - i]) ?? 0 }
  func fill(_ evenOdd: Bool) {
    if !path.isEmpty { emit(Fill(d: path, evenOdd: evenOdd, gray: gray, mask: mask)) }
    path = ""
  }
  let tokens = content.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\r" })
  for raw in tokens {
    let token = String(raw)
    if token.first == "/" || Double(token) != nil {
      operands.append(token)
      continue
    }
    switch token {
    case "q": stack.append((ctm, gray, mask))
    case "Q": if let top = stack.popLast() { (ctm, gray, mask) = top }
    case "cm":
      ctm = ctm.concat(Affine(a: n(6), b: n(5), c: n(4), d: n(3), e: n(2), f: n(1)))
    case "m": path += "M\(point(n(2), n(1)))"
    case "l": path += "L\(point(n(2), n(1)))"
    case "c": path += "C\(point(n(6), n(5))) \(point(n(4), n(3))) \(point(n(2), n(1)))"
    case "v", "y":
      // Rare shorthand curves; a line keeps the outline closed if they ever appear.
      path += "L\(point(n(2), n(1)))"
    case "h": path += "Z"
    case "re":
      let (x, y, w, h) = (n(4), n(3), n(2), n(1))
      path += "M\(point(x, y))L\(point(x + w, y))L\(point(x + w, y + h))L\(point(x, y + h))Z"
    case "f", "F": fill(false)
    case "f*": fill(true)
    case "n": path = ""
    case "g", "sc", "scn", "rg":
      let values = operands.compactMap(Double.init)
      if values.count >= 3 {
        let rgb = values.suffix(3).map { $0 }
        gray = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
      } else if let v = values.last {
        gray = v
      }
    case "gs":
      let name = String(operands.last?.dropFirst() ?? "")
      guard let state = subDict(subDict(resources, "ExtGState"), name) else { break }
      var softMaskName: UnsafePointer<CChar>?
      if CGPDFDictionaryGetName(state, "SMask", &softMaskName) {
        mask = nil
      } else if let softMask = subDict(state, "SMask"), let group = stream(softMask, "G"),
        let groupDict = CGPDFStreamGetDictionary(group)
      {
        var fills: [Fill] = []
        walk(
          streamText(group), resources: subDict(groupDict, "Resources"),
          ctm: ctm.concat(matrix(groupDict)), height: height
        ) { fills.append($0) }
        var subtype: UnsafePointer<CChar>?
        let alpha = CGPDFDictionaryGetName(softMask, "S", &subtype) && String(cString: subtype!) == "Alpha"
        var backdrop: CGPDFArrayRef?
        var level: CGPDFReal = 0
        if CGPDFDictionaryGetArray(softMask, "BC", &backdrop), let backdrop {
          var values: [CGPDFReal] = []
          for i in 0..<CGPDFArrayGetCount(backdrop) {
            var v: CGPDFReal = 0
            CGPDFArrayGetNumber(backdrop, i, &v)
            values.append(v)
          }
          level = values.count >= 3 ? 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2] : values.first ?? 0
        }
        mask = Mask(alpha: alpha, backdrop: level, fills: fills)
      }
    case "Do":
      let name = String(operands.last?.dropFirst() ?? "")
      if let form = stream(subDict(resources, "XObject"), name),
        let formDict = CGPDFStreamGetDictionary(form)
      {
        walk(
          streamText(form), resources: subDict(formDict, "Resources"),
          ctm: ctm.concat(matrix(formDict)), height: height, emit: emit)
      }
    default: break
    }
    operands.removeAll()
  }
}

struct Symbol: Encodable {
  let width: Double
  let height: Double
  let fills: [Fill]
}

@MainActor func extract(pointSize: Double, names: [String]) -> [String: Symbol] {
  var out: [String: Symbol] = [:]
  for name in names {
    let view = Image(systemName: name).font(.system(size: pointSize, weight: .regular))
      .foregroundStyle(.black)
    let data = NSMutableData()
    var size = CGSize.zero
    ImageRenderer(content: view).render { renderedSize, draw in
      size = renderedSize
      var box = CGRect(origin: .zero, size: renderedSize)
      let context = CGContext(
        consumer: CGDataConsumer(data: data as CFMutableData)!, mediaBox: &box, nil)!
      context.beginPDFPage(nil)
      draw(context)
      context.endPDFPage()
      context.closePDF()
    }
    guard let page = CGPDFDocument(CGDataProvider(data: data as CFData)!)?.page(at: 1),
      let pageDict = page.dictionary, let contents = stream(pageDict, "Contents")
    else { continue }
    var fills: [Fill] = []
    walk(
      streamText(contents), resources: subDict(pageDict, "Resources"), ctm: Affine(),
      height: size.height
    ) { fills.append($0) }
    if !fills.isEmpty { out[name] = Symbol(width: size.width, height: size.height, fills: fills) }
  }
  return out
}

let args = Array(CommandLine.arguments.dropFirst())
let pointSize = Double(args.first ?? "") ?? 20
let symbols = MainActor.assumeIsolated { extract(pointSize: pointSize, names: Array(args.dropFirst())) }
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
FileHandle.standardOutput.write(try! encoder.encode(symbols))
