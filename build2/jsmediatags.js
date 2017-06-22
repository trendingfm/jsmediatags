'use strict';

// React Native does not support the Node.js 'fs' module, so we must
// comment it out in this fork to get it to work there.
//
// NOTE: Should find a way to reliably detect React Native. Did not work
// to wrap the 'fs' require inside a try/catch block. Was still a fatal error.
// Until then, this fork will only work on React Native.

const MediaFileReader = require("./MediaFileReader");
// const NodeFileReader = require("./NodeFileReader");
const XhrFileReader = require("./XhrFileReader");
const BlobFileReader = require("./BlobFileReader");
const ArrayFileReader = require("./ArrayFileReader");
const MediaTagReader = require("./MediaTagReader");
const ID3v1TagReader = require("./ID3v1TagReader");
const ID3v2TagReader = require("./ID3v2TagReader");
const MP4TagReader = require("./MP4TagReader");

var mediaFileReaders = [];
var mediaTagReaders = [];

function read(location, callbacks) {
  new Reader(location).read(callbacks);
}

function isRangeValid(range, fileSize) {
  const invalidPositiveRange = range.offset >= 0 && range.offset + range.length >= fileSize;

  const invalidNegativeRange = range.offset < 0 && (-range.offset > fileSize || range.offset + range.length > 0);

  return !(invalidPositiveRange || invalidNegativeRange);
}

class Reader {

  constructor(file) {
    this._file = file;
  }

  setTagsToRead(tagsToRead) {
    this._tagsToRead = tagsToRead;
    return this;
  }

  setFileReader(fileReader) {
    this._fileReader = fileReader;
    return this;
  }

  setTagReader(tagReader) {
    this._tagReader = tagReader;
    return this;
  }

  read(callbacks) {
    var FileReader = this._getFileReader();
    var fileReader = new FileReader(this._file);
    var self = this;

    fileReader.init({
      onSuccess: function () {
        self._getTagReader(fileReader, {
          onSuccess: function (TagReader) {
            new TagReader(fileReader).setTagsToRead(self._tagsToRead).read(callbacks);
          },
          onError: callbacks.onError
        });
      },
      onError: callbacks.onError
    });
  }

  _getFileReader() {
    if (this._fileReader) {
      return this._fileReader;
    } else {
      return this._findFileReader();
    }
  }

  _findFileReader() {
    for (var i = 0; i < mediaFileReaders.length; i++) {
      if (mediaFileReaders[i].canReadFile(this._file)) {
        return mediaFileReaders[i];
      }
    }

    throw new Error("No suitable file reader found for ", this._file);
  }

  _getTagReader(fileReader, callbacks) {
    if (this._tagReader) {
      var tagReader = this._tagReader;
      setTimeout(function () {
        callbacks.onSuccess(tagReader);
      }, 1);
    } else {
      this._findTagReader(fileReader, callbacks);
    }
  }

  _findTagReader(fileReader, callbacks) {
    // We don't want to make multiple fetches per tag reader to get the tag
    // identifier. The strategy here is to combine all the tag identifier
    // ranges into one and make a single fetch. This is particularly important
    // in file readers that have expensive loads like the XHR one.
    // However, with this strategy we run into the problem of loading the
    // entire file because tag identifiers might be at the start or end of
    // the file.
    // To get around this we divide the tag readers into two categories, the
    // ones that read their tag identifiers from the start of the file and the
    // ones that read from the end of the file.
    var tagReadersAtFileStart = [];
    var tagReadersAtFileEnd = [];
    var fileSize = fileReader.getSize();

    for (var i = 0; i < mediaTagReaders.length; i++) {
      var range = mediaTagReaders[i].getTagIdentifierByteRange();
      if (!isRangeValid(range, fileSize)) {
        continue;
      }

      if (range.offset >= 0 && range.offset < fileSize / 2 || range.offset < 0 && range.offset < -fileSize / 2) {
        tagReadersAtFileStart.push(mediaTagReaders[i]);
      } else {
        tagReadersAtFileEnd.push(mediaTagReaders[i]);
      }
    }

    var tagsLoaded = false;
    var loadTagIdentifiersCallbacks = {
      onSuccess: function () {
        if (!tagsLoaded) {
          // We're expecting to load two sets of tag identifiers. This flag
          // indicates when the first one has been loaded.
          tagsLoaded = true;
          return;
        }

        for (var i = 0; i < mediaTagReaders.length; i++) {
          var range = mediaTagReaders[i].getTagIdentifierByteRange();
          if (!isRangeValid(range, fileSize)) {
            continue;
          }

          try {
            var tagIndentifier = fileReader.getBytesAt(range.offset >= 0 ? range.offset : range.offset + fileSize, range.length);
          } catch (ex) {
            if (callbacks.onError) {
              callbacks.onError({
                "type": "fileReader",
                "info": ex.message
              });
              return;
            }
          }

          if (mediaTagReaders[i].canReadTagFormat(tagIndentifier)) {
            callbacks.onSuccess(mediaTagReaders[i]);
            return;
          }
        }

        if (callbacks.onError) {
          callbacks.onError({
            "type": "tagFormat",
            "info": "No suitable tag reader found"
          });
        }
      },
      onError: callbacks.onError
    };

    this._loadTagIdentifierRanges(fileReader, tagReadersAtFileStart, loadTagIdentifiersCallbacks);
    this._loadTagIdentifierRanges(fileReader, tagReadersAtFileEnd, loadTagIdentifiersCallbacks);
  }

  _loadTagIdentifierRanges(fileReader, tagReaders, callbacks) {
    if (tagReaders.length === 0) {
      // Force async
      setTimeout(callbacks.onSuccess, 1);
      return;
    }

    var tagIdentifierRange = [Number.MAX_VALUE, 0];
    var fileSize = fileReader.getSize();

    // Create a super set of all ranges so we can load them all at once.
    // Might need to rethink this approach if there are tag ranges too far
    // a part from each other. We're good for now though.
    for (var i = 0; i < tagReaders.length; i++) {
      var range = tagReaders[i].getTagIdentifierByteRange();
      var start = range.offset >= 0 ? range.offset : range.offset + fileSize;
      var end = start + range.length - 1;

      tagIdentifierRange[0] = Math.min(start, tagIdentifierRange[0]);
      tagIdentifierRange[1] = Math.max(end, tagIdentifierRange[1]);
    }

    fileReader.loadRange(tagIdentifierRange, callbacks);
  }
}

class Config {
  static addFileReader(fileReader) {
    mediaFileReaders.push(fileReader);
    return Config;
  }

  static addTagReader(tagReader) {
    mediaTagReaders.push(tagReader);
    return Config;
  }

  static removeTagReader(tagReader) {
    var tagReaderIx = mediaTagReaders.indexOf(tagReader);

    if (tagReaderIx >= 0) {
      mediaTagReaders.splice(tagReaderIx, 1);
    }

    return Config;
  }

  static EXPERIMENTAL_avoidHeadRequests() {
    XhrFileReader.setConfig({
      avoidHeadRequests: true
    });
  }

  static setDisallowedXhrHeaders(disallowedXhrHeaders) {
    XhrFileReader.setConfig({
      disallowedXhrHeaders: disallowedXhrHeaders
    });
  }

  static setXhrTimeoutInSec(timeoutInSec) {
    XhrFileReader.setConfig({
      timeoutInSec: timeoutInSec
    });
  }
}

Config.addFileReader(XhrFileReader).addFileReader(BlobFileReader).addFileReader(ArrayFileReader).addTagReader(ID3v2TagReader).addTagReader(ID3v1TagReader).addTagReader(MP4TagReader);

// Comment out all references to 'fs' module for React Native.

// if (typeof process !== "undefined") {
//   Config
//     .addFileReader(NodeFileReader);
// }

module.exports = {
  "read": read,
  "Reader": Reader,
  "Config": Config
};