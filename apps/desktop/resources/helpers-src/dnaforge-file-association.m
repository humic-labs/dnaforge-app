#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static void PrintJSON(NSDictionary *payload) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
  if (data == nil) {
    fprintf(stderr, "%s\n", error.localizedDescription.UTF8String);
    return;
  }
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
}

static NSDictionary *HandlerInfo(NSURL *applicationURL) {
  if (applicationURL == nil) return nil;
  NSBundle *bundle = [NSBundle bundleWithURL:applicationURL];
  NSString *name = [bundle objectForInfoDictionaryKey:@"CFBundleDisplayName"];
  if (name.length == 0) name = [bundle objectForInfoDictionaryKey:@"CFBundleName"];
  if (name.length == 0) name = applicationURL.lastPathComponent.stringByDeletingPathExtension;
  return @{
    @"bundleId": bundle.bundleIdentifier ?: @"",
    @"name": name ?: @"",
    @"path": applicationURL.path ?: @""
  };
}

static int PrintHandlerForType(UTType *contentType) {
  if (contentType == nil) {
    PrintJSON(@{ @"ok": @NO, @"error": @"Unknown content type." });
    return 2;
  }
  NSURL *url = [[NSWorkspace sharedWorkspace] URLForApplicationToOpenContentType:contentType];
  PrintJSON(@{ @"ok": @YES, @"handler": HandlerInfo(url) ?: [NSNull null] });
  return 0;
}

static int InspectFile(NSString *path) {
  NSURL *url = [NSURL fileURLWithPath:path];
  UTType *type = nil;
  NSError *error = nil;
  if (![url getResourceValue:&type forKey:NSURLContentTypeKey error:&error] || !type) {
    PrintJSON(@{ @"ok": @NO, @"error": error.localizedDescription ?: @"Unknown file type." });
    return 2;
  }
  NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
  NSMutableArray *candidates = [NSMutableArray array];
  for (NSURL *candidate in [workspace URLsForApplicationsToOpenURL:url]) {
    [candidates addObject:HandlerInfo(candidate)];
  }
  PrintJSON(@{ @"ok": @YES, @"contentType": type.identifier,
               @"handler": HandlerInfo([workspace URLForApplicationToOpenURL:url]) ?: [NSNull null],
               @"candidates": candidates });
  return 0;
}

static int QueryHandler(NSString *identifier) {
  return PrintHandlerForType([UTType typeWithIdentifier:identifier]);
}

static int QueryHandlerForExtension(NSString *extension) {
  return PrintHandlerForType([UTType typeWithFilenameExtension:extension]);
}

static int SetHandler(NSString *identifier, NSString *applicationPath) {
  UTType *contentType = [UTType typeWithIdentifier:identifier];
  NSURL *applicationURL = [NSURL fileURLWithPath:applicationPath isDirectory:YES];
  if (contentType == nil || applicationPath.length == 0) {
    PrintJSON(@{ @"ok": @NO, @"error": @"Invalid content type or application path." });
    return 2;
  }

  __block BOOL completed = NO;
  __block NSError *operationError = nil;
  [[NSWorkspace sharedWorkspace]
      setDefaultApplicationAtURL:applicationURL
               toOpenContentType:contentType
               completionHandler:^(NSError *error) {
                 operationError = error;
                 completed = YES;
               }];

  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15.0];
  while (!completed && deadline.timeIntervalSinceNow > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                             beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  if (!completed) {
    PrintJSON(@{ @"ok": @NO, @"error": @"The macOS handler request timed out." });
    return 3;
  }
  if (operationError != nil) {
    PrintJSON(@{ @"ok": @NO, @"error": operationError.localizedDescription ?: @"Request failed." });
    return 4;
  }
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) {
      fprintf(
          stderr,
          "Usage: dnaforge-file-association query <uti> | query-extension <ext> | inspect-file <path> | set-extensions <app> <allowed-types> <extensions...> | set <uti> <app-path>\n"
      );
      return 64;
    }
    NSString *command = [NSString stringWithUTF8String:argv[1]];
    NSString *identifier = [NSString stringWithUTF8String:argv[2]];
    if ([command isEqualToString:@"query"]) return QueryHandler(identifier);
    if ([command isEqualToString:@"query-extension"]) return QueryHandlerForExtension(identifier);
    if ([command isEqualToString:@"query-extensions"]) {
      NSMutableSet *handlers = [NSMutableSet set];
      for (int index = 2; index < argc; index++) {
        UTType *type = [UTType typeWithFilenameExtension:[NSString stringWithUTF8String:argv[index]]];
        if (type == nil) {
          PrintJSON(@{ @"ok": @NO, @"error": @"Unknown filename extension." });
          return 2;
        }
        NSURL *url = [[NSWorkspace sharedWorkspace] URLForApplicationToOpenContentType:type];
        [handlers addObject:HandlerInfo(url) ?: [NSNull null]];
      }
      id handler = handlers.count == 1 ? handlers.anyObject : @{ @"name": @"Multiple applications" };
      PrintJSON(@{ @"ok": @YES, @"handler": handler });
      return 0;
    }
    if ([command isEqualToString:@"inspect-file"] && argc == 3) return InspectFile(identifier);
    if ([command isEqualToString:@"set-extensions"] && argc >= 5) {
      NSArray *allowedTypes = [[NSString stringWithUTF8String:argv[3]] componentsSeparatedByString:@","];
      NSMutableOrderedSet *types = [NSMutableOrderedSet orderedSet];
      for (int index = 4; index < argc; index++) {
        NSString *extension = [NSString stringWithUTF8String:argv[index]];
        UTType *type = [UTType typeWithFilenameExtension:extension];
        if (!type || ![allowedTypes containsObject:type.identifier]) {
          NSString *error = [NSString stringWithFormat:
            @"macOS identifies .%@ as %@. Use Finder’s Get Info to choose its app.", extension, type.identifier ?: @"unknown"];
          PrintJSON(@{ @"ok": @NO, @"error": error });
          return 2;
        }
        [types addObject:type.identifier];
      }
      for (NSString *type in types) {
        int code = SetHandler(type, identifier);
        if (code != 0) return code;
      }
      PrintJSON(@{ @"ok": @YES });
      return 0;
    }
    if ([command isEqualToString:@"set"] && argc == 4) {
      int code = SetHandler(identifier, [NSString stringWithUTF8String:argv[3]]);
      if (code == 0) PrintJSON(@{ @"ok": @YES });
      return code;
    }
    fprintf(stderr, "Unsupported command.\n");
    return 64;
  }
}
