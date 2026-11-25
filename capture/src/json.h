// Minimal JSON reader, enough for the host's CONFIG message. Never throws; bad input gives null values.
#pragma once

#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

struct JValue {
    enum Type { Null, Bool, Number, String, Array, Object } type = Null;
    bool b = false;
    double num = 0;
    std::string str;
    std::vector<JValue> arr;
    std::vector<std::pair<std::string, JValue>> obj;

    const JValue& operator[](const char* key) const {
        static const JValue none;
        if (type == Object)
            for (auto& kv : obj)
                if (kv.first == key) return kv.second;
        return none;
    }
    const JValue& operator[](size_t i) const {
        static const JValue none;
        return (type == Array && i < arr.size()) ? arr[i] : none;
    }
    size_t size() const { return type == Array ? arr.size() : 0; }
    int asInt(int def = 0) const { return type == Number ? int(num) : def; }
    double asDouble(double def = 0) const { return type == Number ? double(num) : def; }
    bool asBool(bool def = false) const { return type == Bool ? b : def; }
    std::string asString() const { return type == String ? str : std::string(); }
    bool isNull() const { return type == Null; }
};

class JParser {
public:
    explicit JParser(const std::string& s) : p_(s.c_str()), end_(s.c_str() + s.size()) {}
    JValue parse() {
        JValue v = value(0);
        return v;
    }

private:
    const char* p_;
    const char* end_;

    void ws() {
        while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\n' || *p_ == '\r')) ++p_;
    }
    bool lit(const char* w) {
        size_t n = strlen(w);
        if (size_t(end_ - p_) >= n && strncmp(p_, w, n) == 0) {
            p_ += n;
            return true;
        }
        return false;
    }
    JValue value(int depth) {
        JValue v;
        ws();
        if (p_ >= end_ || depth > 32) return v;
        char c = *p_;
        if (c == '{') {
            ++p_;
            v.type = JValue::Object;
            ws();
            if (p_ < end_ && *p_ == '}') { ++p_; return v; }
            while (p_ < end_) {
                ws();
                if (p_ >= end_ || *p_ != '"') return JValue();
                std::string k = string();
                ws();
                if (p_ >= end_ || *p_ != ':') return JValue();
                ++p_;
                v.obj.emplace_back(std::move(k), value(depth + 1));
                ws();
                if (p_ < end_ && *p_ == ',') { ++p_; continue; }
                if (p_ < end_ && *p_ == '}') { ++p_; return v; }
                return JValue();
            }
            return JValue();
        }
        if (c == '[') {
            ++p_;
            v.type = JValue::Array;
            ws();
            if (p_ < end_ && *p_ == ']') { ++p_; return v; }
            while (p_ < end_) {
                v.arr.push_back(value(depth + 1));
                ws();
                if (p_ < end_ && *p_ == ',') { ++p_; continue; }
                if (p_ < end_ && *p_ == ']') { ++p_; return v; }
                return JValue();
            }
            return JValue();
        }
        if (c == '"') {
            v.type = JValue::String;
            v.str = string();
            return v;
        }
        if (lit("true")) { v.type = JValue::Bool; v.b = true; return v; }
        if (lit("false")) { v.type = JValue::Bool; return v; }
        if (lit("null")) return v;
        char* stop = nullptr;
        double d = strtod(p_, &stop);
        if (stop == p_) { p_ = end_; return v; }
        p_ = stop;
        v.type = JValue::Number;
        v.num = d;
        return v;
    }
    std::string string() {
        std::string out;
        ++p_;  // opening quote
        while (p_ < end_ && *p_ != '"') {
            if (*p_ == '\\' && p_ + 1 < end_) {
                ++p_;
                switch (*p_) {
                    case 'n': out += '\n'; break;
                    case 't': out += '\t'; break;
                    case 'r': out += '\r'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'u':
                        // Our messages are ASCII; keep \uXXXX as '?'.
                        out += '?';
                        p_ += (end_ - p_ > 4) ? 4 : 0;
                        break;
                    default: out += *p_;
                }
                ++p_;
            } else {
                out += *p_++;
            }
        }
        if (p_ < end_) ++p_;  // closing quote
        return out;
    }
};

inline JValue JParse(const std::string& s) { return JParser(s).parse(); }
