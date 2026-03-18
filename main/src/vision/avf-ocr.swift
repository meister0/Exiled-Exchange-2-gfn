import Foundation
import Vision
import CoreGraphics

// Apple Vision Framework OCR helper.
// Usage:
//   avf-ocr --bgra <width> <height>   — reads raw BGRA pixels from stdin
//   avf-ocr <png-file-path>            — reads PNG from file
//   avf-ocr                            — reads PNG from stdin
// Output: JSON array of recognized text observations to stdout.

struct TextObservation: Codable {
    let text: String
    let confidence: Float
    let bbox: BBox
}

struct BBox: Codable {
    let x: Int
    let y: Int
    let w: Int
    let h: Int
}

let args = Array(CommandLine.arguments.dropFirst())
var cgImage: CGImage

if args.first == "--bgra", args.count >= 3,
   let width = Int(args[1]), let height = Int(args[2]) {
    // Raw BGRA from stdin — skip PNG encode/decode entirely
    let rawData = FileHandle.standardInput.readDataToEndOfFile()
    let expectedSize = width * height * 4
    guard rawData.count == expectedSize else {
        fputs("Error: expected \(expectedSize) bytes for \(width)x\(height) BGRA, got \(rawData.count)\n", stderr)
        exit(1)
    }

    // Create CGImage directly from BGRA data
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.first.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    guard let provider = CGDataProvider(data: rawData as CFData),
          let img = CGImage(
              width: width, height: height,
              bitsPerComponent: 8, bitsPerPixel: 32,
              bytesPerRow: width * 4,
              space: colorSpace, bitmapInfo: bitmapInfo,
              provider: provider, decode: nil,
              shouldInterpolate: false, intent: .defaultIntent
          ) else {
        fputs("Error: cannot create CGImage from BGRA data\n", stderr)
        exit(1)
    }
    cgImage = img
} else {
    // PNG mode (file or stdin)
    let nonFlagArgs = args.filter { !$0.hasPrefix("--") }
    let imageData: Data
    if let filePath = nonFlagArgs.first {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: filePath)) else {
            fputs("Error: cannot read file at \(filePath)\n", stderr)
            exit(1)
        }
        imageData = data
    } else {
        imageData = FileHandle.standardInput.readDataToEndOfFile()
    }

    guard let dataProvider = CGDataProvider(data: imageData as CFData),
          let img = CGImage(pngDataProviderSource: dataProvider,
                            decode: nil, shouldInterpolate: false,
                            intent: .defaultIntent) else {
        fputs("Error: cannot decode PNG image\n", stderr)
        exit(1)
    }
    cgImage = img
}

let imageWidth = cgImage.width
let imageHeight = cgImage.height

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

guard let results = request.results else {
    print("[]")
    exit(0)
}

var observations: [TextObservation] = []

for observation in results {
    let text = observation.topCandidates(1).first?.string ?? ""
    let confidence = observation.confidence

    let box = observation.boundingBox
    let x = Int(box.origin.x * Double(imageWidth))
    let y = Int((1.0 - box.origin.y - box.height) * Double(imageHeight))
    let w = Int(box.width * Double(imageWidth))
    let h = Int(box.height * Double(imageHeight))

    observations.append(TextObservation(
        text: text,
        confidence: confidence,
        bbox: BBox(x: x, y: y, w: w, h: h)
    ))
}

let encoder = JSONEncoder()
let jsonData = try encoder.encode(observations)
print(String(data: jsonData, encoding: .utf8)!)
